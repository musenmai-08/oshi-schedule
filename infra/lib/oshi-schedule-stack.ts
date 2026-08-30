import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Arn,
  ArnFormat,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Tags,
  Validations,
  aws_amplify as amplify,
  aws_apigatewayv2 as apigatewayv2,
  aws_apigatewayv2_integrations as apigatewayv2Integrations,
  aws_budgets as budgets,
  aws_certificatemanager as acm,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cloudwatchActions,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_events as events,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_pipes as pipes,
  aws_rds as rds,
  aws_route53 as route53,
  aws_route53_targets as route53Targets,
  aws_scheduler as scheduler,
  aws_secretsmanager as secretsmanager,
  aws_sns as sns,
  aws_sns_subscriptions as subscriptions,
  aws_sqs as sqs,
  aws_ssm as ssm,
  aws_servicediscovery as servicediscovery,
} from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { applicationSecretArnDefinitions, type DeploymentConfig } from './config.js';

interface OshiScheduleStackProps extends StackProps {
  config: DeploymentConfig;
}

class EcsSsmParameterSecret extends ecs.Secret {
  readonly arn: string;
  readonly hasField = false;

  constructor(parameter: ssm.IParameter) {
    super();
    this.arn = parameter.parameterArn;
  }

  grantRead(grantee: iam.IGrantable): iam.Grant {
    // ECS resolves task-definition secrets with the execution role and only calls GetParameters.
    return iam.Grant.addToPrincipal({
      grantee,
      actions: ['ssm:GetParameters'],
      resourceArns: [this.arn],
    });
  }
}

class EcsSecretsManagerSecret extends ecs.Secret {
  readonly arn: string;
  readonly hasField = false;

  constructor(secret: secretsmanager.ISecret) {
    super();
    this.arn = secret.secretArn;
  }

  grantRead(grantee: iam.IGrantable): iam.Grant {
    // ECS secret injection only requires GetSecretValue on the exact complete ARN.
    return iam.Grant.addToPrincipal({
      grantee,
      actions: ['secretsmanager:GetSecretValue'],
      resourceArns: [this.arn],
    });
  }
}

export class OshiScheduleStack extends Stack {
  constructor(scope: Construct, id: string, props: OshiScheduleStackProps) {
    super(scope, id, props);

    const { config } = props;
    const prefix = `oshi-schedule-${config.environmentName}`;
    const isProduction = config.environmentName === 'production';
    const deploymentBranch = 'main';
    const autoSleepCodePath = [
      new URL('../../scripts/aws/staging-auto-sleep', import.meta.url),
      new URL('../../../scripts/aws/staging-auto-sleep', import.meta.url),
    ]
      .map((url) => fileURLToPath(url))
      .find(existsSync);
    if (!autoSleepCodePath) throw new Error('Staging auto-sleep Lambda source was not found');
    const amplifyBuildSpecPath = [
      new URL('../../amplify.yml', import.meta.url),
      new URL('../../../amplify.yml', import.meta.url),
    ]
      .map((url) => fileURLToPath(url))
      .find(existsSync);
    if (!amplifyBuildSpecPath) throw new Error('Amplify build specification was not found');
    const amplifyBuildSpec = readFileSync(amplifyBuildSpecPath, 'utf8').trimEnd();
    const webOrigin = config.webDomainName
      ? `https://${config.webDomainName}`
      : 'https://domain-required.invalid';

    Tags.of(this).add('Application', 'oshi-schedule');
    Tags.of(this).add('Environment', config.environmentName);
    Tags.of(this).add('ManagedBy', 'aws-cdk');
    Validations.of(this).acknowledge({
      id: 'CloudFormation-Validate::W2001',
      reason:
        'Imported SSM parameter names are referenced by ECS secret ARNs at runtime; CDK lookup parameters are intentionally not Ref-ed.',
    });

    const vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${prefix}-vpc`,
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'database', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const repository = new ecr.Repository(this, 'Repository', {
      repositoryName: prefix,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      lifecycleRules: [{ maxImageCount: isProduction ? 50 : 20 }],
      removalPolicy: RemovalPolicy.RETAIN,
      emptyOnDelete: false,
    });
    new CfnOutput(this, 'EnvironmentName', { value: config.environmentName });
    if (config.bootstrapOnly) {
      new CfnOutput(this, 'EcrRepositoryUri', { value: repository.repositoryUri });
      return;
    }
    const cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `${prefix}-cluster`,
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    const notificationTopic = new sns.Topic(this, 'Alerts', {
      topicName: `${prefix}-alerts`,
      displayName: `${prefix} operational alerts`,
    });
    if (config.alertEmail) {
      notificationTopic.addSubscription(new subscriptions.EmailSubscription(config.alertEmail));
    }

    const vpcLinkSecurityGroup = new ec2.SecurityGroup(this, 'VpcLinkSecurityGroup', {
      vpc,
      description: 'API Gateway VPC Link reaches only the API service',
      allowAllOutbound: false,
    });

    const apiSecurityGroup = new ec2.SecurityGroup(this, 'ApiSecurityGroup', {
      vpc,
      description: 'API tasks accept traffic only from the API Gateway VPC Link',
      allowAllOutbound: true,
    });
    vpcLinkSecurityGroup.addEgressRule(apiSecurityGroup, ec2.Port.tcp(4000), 'VPC Link to API');
    apiSecurityGroup.addIngressRule(vpcLinkSecurityGroup, ec2.Port.tcp(4000), 'VPC Link to API');
    const workerSecurityGroup = new ec2.SecurityGroup(this, 'WorkerSecurityGroup', {
      vpc,
      description: 'Worker and migration tasks have no inbound rules',
      allowAllOutbound: true,
    });
    const databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc,
      description: 'MySQL accepts traffic only from application tasks',
      allowAllOutbound: false,
    });
    databaseSecurityGroup.addIngressRule(apiSecurityGroup, ec2.Port.tcp(3306), 'API to MySQL');
    databaseSecurityGroup.addIngressRule(
      workerSecurityGroup,
      ec2.Port.tcp(3306),
      'Worker and migration to MySQL',
    );

    const databaseEngine = rds.DatabaseInstanceEngine.mysql({
      version: rds.MysqlEngineVersion.VER_8_4_10,
    });
    const databaseParameterGroup = new rds.ParameterGroup(this, 'DatabaseParameterGroup', {
      engine: databaseEngine,
      description: `${prefix} requires encrypted MySQL transport`,
      parameters: { require_secure_transport: '1' },
    });
    const database = new rds.DatabaseInstance(this, 'Database', {
      instanceIdentifier: `${prefix}-mysql`,
      engine: databaseEngine,
      parameterGroup: databaseParameterGroup,
      credentials: rds.Credentials.fromGeneratedSecret('oshiadmin', {
        secretName: `${prefix}/rds/credentials`,
      }),
      databaseName: `oshi_schedule_${config.environmentName}`,
      instanceType: new ec2.InstanceType(config.rdsInstanceType),
      allocatedStorage: config.rdsAllocatedStorageGiB,
      maxAllocatedStorage: Math.max(config.rdsAllocatedStorageGiB, 100),
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      backupRetention: Duration.days(config.rdsBackupRetentionDays),
      deleteAutomatedBackups: false,
      deletionProtection: isProduction || config.rdsDeletionProtection,
      multiAz: config.rdsMultiAz,
      publiclyAccessible: false,
      autoMinorVersionUpgrade: true,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [databaseSecurityGroup],
      cloudwatchLogsExports: ['error', 'slowquery'],
      cloudwatchLogsRetention: isProduction
        ? logs.RetentionDays.ONE_MONTH
        : logs.RetentionDays.TWO_WEEKS,
    });
    database.applyRemovalPolicy(isProduction ? RemovalPolicy.RETAIN : RemovalPolicy.SNAPSHOT);

    const runtimeParameters = {
      APP_MODE: new ssm.StringParameter(this, 'AppModeParameter', {
        parameterName: `/${prefix}/runtime/app-mode`,
        stringValue: 'real',
      }),
      TRUST_PROXY_HOPS: new ssm.StringParameter(this, 'TrustProxyParameter', {
        parameterName: `/${prefix}/runtime/trust-proxy-hops`,
        stringValue: '1',
      }),
      LOG_LEVEL: new ssm.StringParameter(this, 'LogLevelParameter', {
        parameterName: `/${prefix}/runtime/log-level`,
        stringValue: 'info',
      }),
      WEB_ORIGIN: new ssm.StringParameter(this, 'WebOriginParameter', {
        parameterName: `/${prefix}/runtime/web-origin`,
        stringValue: webOrigin,
      }),
      YOUTUBE_DAILY_QUOTA_BUDGET: new ssm.StringParameter(this, 'QuotaBudgetParameter', {
        parameterName: `/${prefix}/runtime/youtube-daily-quota-budget`,
        stringValue: '8000',
      }),
      YOUTUBE_DAILY_SEARCH_QUOTA_BUDGET: new ssm.StringParameter(
        this,
        'SearchQuotaBudgetParameter',
        {
          parameterName: `/${prefix}/runtime/youtube-daily-search-quota-budget`,
          stringValue: '80',
        },
      ),
    };
    const applicationActivationParameter = new ssm.StringParameter(
      this,
      'ApplicationActivationParameter',
      {
        parameterName: `/${prefix}/runtime/application-activated`,
        description: 'Migration-safe application activation marker used by operational guards',
        stringValue: String(config.applicationActivated),
        tier: ssm.ParameterTier.STANDARD,
      },
    );
    const allowedEmailsParameter = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      'AllowedEmailsParameter',
      { parameterName: `/${prefix}/runtime/allowed-emails`, simpleName: false },
    );
    const referencedParameters = {
      SUPABASE_URL: isProduction
        ? new ssm.StringParameter(this, 'SupabaseUrlParameter', {
            parameterName: `/${prefix}/runtime/supabase-url`,
            stringValue: config.nextPublicSupabaseUrl ?? 'REQUIRED_AT_DEPLOY',
          })
        : ssm.StringParameter.fromStringParameterAttributes(this, 'SupabaseUrlParameter', {
            parameterName: `/${prefix}/runtime/supabase-url`,
            simpleName: false,
          }),
      GOOGLE_CLIENT_ID: isProduction
        ? new ssm.StringParameter(this, 'GoogleClientIdParameter', {
            parameterName: `/${prefix}/runtime/google-client-id`,
            stringValue: config.googleClientId ?? 'REQUIRED_AT_DEPLOY',
          })
        : ssm.StringParameter.fromStringParameterAttributes(this, 'GoogleClientIdParameter', {
            parameterName: `/${prefix}/runtime/google-client-id`,
            simpleName: false,
          }),
    };
    const referencedSecrets = Object.fromEntries(
      applicationSecretArnDefinitions.map((definition) => {
        // Full deploys require a validated environment-specific ARN. The invalid suffix is only
        // for the existing deployReady=false, synth-only template path.
        const completeArn =
          config[definition.contextKey] ??
          `arn:aws:secretsmanager:${config.region}:${config.account ?? '000000000000'}:` +
            `secret:${prefix}/${definition.secretNameSuffix}-000000`;
        return [
          definition.environmentVariable,
          secretsmanager.Secret.fromSecretCompleteArn(this, definition.constructId, completeArn),
        ];
      }),
    );

    const apiLogGroup = new logs.LogGroup(this, 'ApiLogGroup', {
      logGroupName: `/oshi-schedule/${config.environmentName}/api`,
      retention: isProduction ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.TWO_WEEKS,
      removalPolicy: isProduction ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const workerLogGroup = new logs.LogGroup(this, 'WorkerLogGroup', {
      logGroupName: `/oshi-schedule/${config.environmentName}/worker`,
      retention: isProduction ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.TWO_WEEKS,
      removalPolicy: isProduction ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const migrationLogGroup = new logs.LogGroup(this, 'MigrationLogGroup', {
      logGroupName: `/oshi-schedule/${config.environmentName}/migration`,
      retention: isProduction ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.TWO_WEEKS,
      removalPolicy: isProduction ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const httpApiLogGroup = new logs.LogGroup(this, 'HttpApiLogGroup', {
      logGroupName: `/aws/apigateway/${prefix}-http-api`,
      retention: isProduction ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.TWO_WEEKS,
      removalPolicy: isProduction ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    const syncJobDeadLetterQueue = new sqs.Queue(this, 'SyncJobDeadLetterQueue', {
      queueName: `${prefix}-sync-jobs-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    const syncJobQueue = new sqs.Queue(this, 'SyncJobQueue', {
      queueName: `${prefix}-sync-jobs`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(4),
      visibilityTimeout: Duration.minutes(15),
      enforceSSL: true,
      deadLetterQueue: { queue: syncJobDeadLetterQueue, maxReceiveCount: 3 },
    });

    const image = ecs.ContainerImage.fromEcrRepository(repository, config.imageTag);
    const databaseEnvironment = {
      DB_HOST: database.dbInstanceEndpointAddress,
      DB_PORT: database.dbInstanceEndpointPort,
      DB_NAME: `oshi_schedule_${config.environmentName}`,
      DB_CONNECTION_LIMIT: '5',
    };
    const databaseSecrets = {
      DB_USER: ecs.Secret.fromSecretsManager(database.secret!, 'username'),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(database.secret!, 'password'),
    };
    const sharedApplicationSecrets: Record<string, ecs.Secret> = {
      ...databaseSecrets,
      ...Object.fromEntries(
        Object.entries(runtimeParameters).map(([name, parameter]) => [
          name,
          ecs.Secret.fromSsmParameter(parameter),
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(referencedParameters).map(([name, parameter]) => [
          name,
          ecs.Secret.fromSsmParameter(parameter),
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(referencedSecrets).map(([name, secret]) => [
          name,
          new EcsSecretsManagerSecret(secret),
        ]),
      ),
    };
    const apiApplicationSecrets: Record<string, ecs.Secret> = {
      ...sharedApplicationSecrets,
      ALLOWED_EMAILS: new EcsSsmParameterSecret(allowedEmailsParameter),
    };

    const apiTaskDefinition = new ecs.FargateTaskDefinition(this, 'ApiTaskDefinition', {
      family: `${prefix}-api`,
      cpu: config.apiCpu,
      memoryLimitMiB: config.apiMemoryMiB,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    const apiContainer = apiTaskDefinition.addContainer('api', {
      containerName: 'api',
      image,
      essential: true,
      stopTimeout: Duration.seconds(45),
      logging: ecs.LogDrivers.awsLogs({ logGroup: apiLogGroup, streamPrefix: 'api' }),
      environment: {
        NODE_ENV: 'production',
        PORT: '4000',
        SHUTDOWN_TIMEOUT_SECONDS: '30',
        SUPABASE_JWT_AUDIENCE: 'authenticated',
        SYNC_JOB_QUEUE_URL: syncJobQueue.queueUrl,
        ...databaseEnvironment,
      },
      secrets: apiApplicationSecrets,
      healthCheck: {
        command: [
          'CMD-SHELL',
          'node -e "fetch(\'http://127.0.0.1:4000/health\').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"',
        ],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(30),
      },
    });
    apiContainer.addPortMappings({ containerPort: 4000, protocol: ecs.Protocol.TCP });
    syncJobQueue.grantSendMessages(apiTaskDefinition.taskRole);

    const apiService = new ecs.FargateService(this, 'ApiService', {
      serviceName: `${prefix}-api`,
      cluster,
      taskDefinition: apiTaskDefinition,
      desiredCount: config.apiDesiredCount,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [apiSecurityGroup],
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      enableExecuteCommand: false,
    });
    const namespace = new servicediscovery.PrivateDnsNamespace(this, 'ApiNamespace', {
      name: `${config.environmentName}.oshi-schedule.internal`,
      vpc,
      description: 'Private discovery namespace for the API Gateway integration',
    });
    const apiDiscoveryService = apiService.enableCloudMap({
      name: 'api',
      cloudMapNamespace: namespace,
      dnsRecordType: servicediscovery.DnsRecordType.SRV,
      dnsTtl: Duration.seconds(30),
      container: apiContainer,
    });
    const vpcLink = new apigatewayv2.VpcLink(this, 'VpcLink', {
      vpc,
      vpcLinkName: `${prefix}-api`,
      subnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [vpcLinkSecurityGroup],
    });
    let apiDomain: apigatewayv2.DomainName | undefined;
    let hostedZone: route53.IHostedZone | undefined;

    if (
      config.certificateArn &&
      config.apiDomainName &&
      config.hostedZoneId &&
      config.hostedZoneName
    ) {
      const certificate = acm.Certificate.fromCertificateArn(
        this,
        'ApiCertificate',
        config.certificateArn,
      );
      apiDomain = new apigatewayv2.DomainName(this, 'ApiDomainName', {
        domainName: config.apiDomainName,
        certificate,
        endpointType: apigatewayv2.EndpointType.REGIONAL,
        securityPolicy: apigatewayv2.SecurityPolicy.TLS_1_2,
      });
      hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: config.hostedZoneId,
        zoneName: config.hostedZoneName,
      });
    }
    const httpApi = new apigatewayv2.HttpApi(this, 'HttpApi', {
      apiName: `${prefix}-api`,
      description: 'Private proxy to the oshi-schedule ECS API',
      disableExecuteApiEndpoint: Boolean(apiDomain),
      defaultDomainMapping: apiDomain ? { domainName: apiDomain } : undefined,
      defaultIntegration: new apigatewayv2Integrations.HttpServiceDiscoveryIntegration(
        'ApiIntegration',
        apiDiscoveryService,
        {
          vpcLink,
          method: apigatewayv2.HttpMethod.ANY,
          timeout: Duration.seconds(29),
          parameterMapping: new apigatewayv2.ParameterMapping().overwritePath(
            apigatewayv2.MappingValue.custom('$request.path'),
          ),
        },
      ),
    });
    const defaultStage = httpApi.defaultStage?.node.defaultChild as apigatewayv2.CfnStage;
    defaultStage.defaultRouteSettings = { throttlingBurstLimit: 100, throttlingRateLimit: 50 };
    defaultStage.accessLogSettings = {
      destinationArn: httpApiLogGroup.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId',
        sourceIp: '$context.identity.sourceIp',
        requestTime: '$context.requestTime',
        routeKey: '$context.routeKey',
        httpMethod: '$context.httpMethod',
        path: '$context.path',
        status: '$context.status',
        integrationStatus: '$context.integration.status',
        integrationLatency: '$context.integration.latency',
        responseLength: '$context.responseLength',
      }),
    };
    if (apiDomain && hostedZone && config.apiDomainName) {
      new route53.ARecord(this, 'ApiAliasRecord', {
        zone: hostedZone,
        recordName: config.apiDomainName,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.ApiGatewayv2DomainProperties(
            apiDomain.regionalDomainName,
            apiDomain.regionalHostedZoneId,
          ),
        ),
      });
    }

    const workerTaskDefinition = new ecs.FargateTaskDefinition(this, 'WorkerTaskDefinition', {
      family: `${prefix}-worker`,
      cpu: config.workerCpu,
      memoryLimitMiB: config.workerMemoryMiB,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    workerTaskDefinition.addContainer('worker', {
      containerName: 'worker',
      image,
      command: ['node', 'worker/dist/index.js'],
      essential: true,
      logging: ecs.LogDrivers.awsLogs({ logGroup: workerLogGroup, streamPrefix: 'worker' }),
      environment: {
        NODE_ENV: 'production',
        SYNC_JOB_QUEUE_URL: syncJobQueue.queueUrl,
        ...databaseEnvironment,
      },
      secrets: sharedApplicationSecrets,
    });

    const syncPipeRole = new iam.Role(this, 'SyncPipeRole', {
      roleName: `${prefix}-sync-pipe`,
      assumedBy: new iam.ServicePrincipal('pipes.amazonaws.com'),
    });
    syncJobQueue.grantConsumeMessages(syncPipeRole);
    syncPipeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:RunTask'],
        resources: [workerTaskDefinition.taskDefinitionArn],
        conditions: { ArnEquals: { 'ecs:cluster': cluster.clusterArn } },
      }),
    );
    syncPipeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [
          workerTaskDefinition.executionRole!.roleArn,
          workerTaskDefinition.taskRole.roleArn,
        ],
        conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
      }),
    );
    const syncPipe = new pipes.CfnPipe(this, 'SyncPipe', {
      name: `${prefix}-sync-jobs`,
      description: 'Starts one targeted Fargate worker for each durable manual sync job',
      roleArn: syncPipeRole.roleArn,
      desiredState: config.syncPipeDesiredState,
      source: syncJobQueue.queueArn,
      sourceParameters: {
        sqsQueueParameters: { batchSize: 1, maximumBatchingWindowInSeconds: 0 },
      },
      target: cluster.clusterArn,
      targetParameters: {
        ecsTaskParameters: {
          taskDefinitionArn: workerTaskDefinition.taskDefinitionArn,
          taskCount: 1,
          launchType: 'FARGATE',
          platformVersion: 'LATEST',
          enableExecuteCommand: false,
          networkConfiguration: {
            awsvpcConfiguration: {
              assignPublicIp: 'ENABLED',
              securityGroups: [workerSecurityGroup.securityGroupId],
              subnets: vpc.publicSubnets.map((subnet) => subnet.subnetId),
            },
          },
          overrides: {
            containerOverrides: [
              {
                name: 'worker',
                environment: [{ name: 'SYNC_RUN_ID', value: '$.body.syncRunId' }],
              },
            ],
          },
        },
      },
    });
    syncPipe.node.addDependency(syncPipeRole);

    const migrationTaskDefinition = new ecs.FargateTaskDefinition(this, 'MigrationTaskDefinition', {
      family: `${prefix}-migration`,
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    migrationTaskDefinition.addContainer('migration', {
      containerName: 'migration',
      image,
      command: [
        'api/node_modules/.bin/prisma',
        'migrate',
        'deploy',
        '--schema=/opt/oshi-schedule/prisma/schema.prisma',
      ],
      essential: true,
      logging: ecs.LogDrivers.awsLogs({ logGroup: migrationLogGroup, streamPrefix: 'migration' }),
      environment: { NODE_ENV: 'production', ...databaseEnvironment },
      secrets: databaseSecrets,
    });

    const schedulerDeadLetterQueue = new sqs.Queue(this, 'SchedulerDeadLetterQueue', {
      queueName: `${prefix}-worker-scheduler-dlq`,
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      roleName: `${prefix}-scheduler`,
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    workerTaskDefinition.grantRun(schedulerRole);
    schedulerDeadLetterQueue.grantSendMessages(schedulerRole);
    const workerSchedule = new scheduler.CfnSchedule(this, 'WorkerSchedule', {
      name: `${prefix}-hourly-worker`,
      description: 'Runs the idempotent leased synchronization worker once per hour',
      scheduleExpression: 'rate(1 hour)',
      flexibleTimeWindow: { mode: 'OFF' },
      state: config.workerScheduleEnabled ? 'ENABLED' : 'DISABLED',
      target: {
        arn: cluster.clusterArn,
        roleArn: schedulerRole.roleArn,
        deadLetterConfig: { arn: schedulerDeadLetterQueue.queueArn },
        retryPolicy: { maximumEventAgeInSeconds: 3600, maximumRetryAttempts: 2 },
        ecsParameters: {
          taskDefinitionArn: workerTaskDefinition.taskDefinitionArn,
          launchType: 'FARGATE',
          platformVersion: 'LATEST',
          networkConfiguration: {
            awsvpcConfiguration: {
              assignPublicIp: 'ENABLED',
              securityGroups: [workerSecurityGroup.securityGroupId],
              subnets: vpc.publicSubnets.map((subnet) => subnet.subnetId),
            },
          },
        },
      },
    });

    const autoSleepAlarms: cloudwatch.Alarm[] = [];
    let wakeExpiresAtParameter: ssm.StringParameter | undefined;
    let autoSleepSchedule: scheduler.CfnSchedule | undefined;
    if (!isProduction) {
      wakeExpiresAtParameter = new ssm.StringParameter(this, 'WakeExpiresAtParameter', {
        parameterName: `/${prefix}/runtime/wake-expires-at`,
        description: 'UTC ISO 8601 deadline for the staging automatic sleep safety net',
        stringValue: 'UNSET',
        tier: ssm.ParameterTier.STANDARD,
      });
      const autoSleepLogGroup = new logs.LogGroup(this, 'AutoSleepLogGroup', {
        logGroupName: `/aws/lambda/${prefix}-auto-sleep`,
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      const autoSleepFunction = new lambda.Function(this, 'AutoSleepFunction', {
        functionName: `${prefix}-auto-sleep`,
        description: 'Stops expired staging compute as a missed-manual-sleep safety net',
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.X86_64,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(autoSleepCodePath),
        memorySize: 128,
        timeout: Duration.minutes(2),
        logGroup: autoSleepLogGroup,
        environment: {
          TARGET_ENVIRONMENT: config.environmentName,
          EXPECTED_ACCOUNT_ID: config.account ?? this.account,
          DEADLINE_PARAMETER_NAME: wakeExpiresAtParameter.parameterName,
          WORKER_SCHEDULE_NAME: workerSchedule.ref,
          ECS_CLUSTER_NAME: cluster.clusterName,
          ECS_API_SERVICE_NAME: apiService.serviceName,
          RDS_INSTANCE_IDENTIFIER: database.instanceIdentifier,
        },
      });
      autoSleepLogGroup.grantWrite(autoSleepFunction);
      autoSleepFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: [wakeExpiresAtParameter.parameterArn],
        }),
      );
      autoSleepFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['scheduler:GetSchedule', 'scheduler:UpdateSchedule'],
          resources: [
            Arn.format(
              {
                service: 'scheduler',
                resource: 'schedule',
                resourceName: `default/${prefix}-hourly-worker`,
                arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
              },
              this,
            ),
          ],
        }),
      );
      autoSleepFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [schedulerRole.roleArn],
          conditions: { StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' } },
        }),
      );
      autoSleepFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ecs:DescribeServices', 'ecs:UpdateService'],
          resources: [apiService.serviceArn],
        }),
      );
      autoSleepFunction.addToRolePolicy(
        new iam.PolicyStatement({ actions: ['rds:DescribeDBInstances'], resources: ['*'] }),
      );
      autoSleepFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['rds:StopDBInstance'],
          resources: [database.instanceArn],
        }),
      );

      const autoSleepSchedulerRole = new iam.Role(this, 'AutoSleepSchedulerRole', {
        roleName: `${prefix}-auto-sleep-scheduler`,
        assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      });
      autoSleepFunction.grantInvoke(autoSleepSchedulerRole);
      autoSleepSchedule = new scheduler.CfnSchedule(this, 'AutoSleepSchedule', {
        name: `${prefix}-auto-sleep`,
        description: 'Checks the staging wake deadline once per hour and safely sleeps on expiry',
        scheduleExpression: 'rate(1 hour)',
        flexibleTimeWindow: { mode: 'OFF' },
        state: 'ENABLED',
        target: {
          arn: autoSleepFunction.functionArn,
          roleArn: autoSleepSchedulerRole.roleArn,
          input: '{}',
          retryPolicy: { maximumEventAgeInSeconds: 3600, maximumRetryAttempts: 2 },
        },
      });
      autoSleepAlarms.push(
        new cloudwatch.Alarm(this, 'AutoSleepFailureAlarm', {
          alarmName: `${prefix}-auto-sleep-failed`,
          metric: autoSleepFunction.metricErrors({ period: Duration.hours(1) }),
          threshold: 1,
          evaluationPeriods: 1,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        }),
      );
    }

    notificationTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [
          new iam.ServicePrincipal('budgets.amazonaws.com'),
          new iam.ServicePrincipal('events.amazonaws.com'),
        ],
        actions: ['sns:Publish'],
        resources: [notificationTopic.topicArn],
      }),
    );
    const failedWorkerRule = new events.CfnRule(this, 'FailedWorkerTaskRule', {
      name: `${prefix}-worker-task-failed`,
      description: 'Detects stopped worker containers whose exit code is not zero',
      state: 'ENABLED',
      eventPattern: {
        source: ['aws.ecs'],
        'detail-type': ['ECS Task State Change'],
        detail: {
          lastStatus: ['STOPPED'],
          taskDefinitionArn: [
            {
              prefix: Arn.format(
                {
                  service: 'ecs',
                  resource: 'task-definition',
                  resourceName: `${prefix}-worker`,
                  arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
                },
                this,
              ),
            },
          ],
          containers: { exitCode: [{ 'anything-but': 0 }] },
        },
      },
      targets: [{ arn: notificationTopic.topicArn, id: 'NotifyOperations' }],
    });

    const alarms = [
      new cloudwatch.Alarm(this, 'ApiCpuAlarm', {
        alarmName: `${prefix}-api-high-cpu`,
        metric: apiService.metricCpuUtilization({ period: Duration.minutes(5) }),
        threshold: 80,
        evaluationPeriods: 3,
      }),
      new cloudwatch.Alarm(this, 'HttpApi5xxAlarm', {
        alarmName: `${prefix}-http-api-5xx`,
        metric: httpApi.metricServerError({ period: Duration.minutes(5), statistic: 'Sum' }),
        threshold: 5,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'DatabaseFreeStorageAlarm', {
        alarmName: `${prefix}-rds-low-storage`,
        metric: database.metricFreeStorageSpace({ period: Duration.minutes(5) }),
        threshold: 2 * 1024 * 1024 * 1024,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 2,
      }),
      new cloudwatch.Alarm(this, 'WorkerFailureAlarm', {
        alarmName: `${prefix}-worker-failed`,
        metric: new cloudwatch.Metric({
          namespace: 'AWS/Events',
          metricName: 'MatchedEvents',
          dimensionsMap: { RuleName: failedWorkerRule.ref },
          period: Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'SyncJobDeadLetterAlarm', {
        alarmName: `${prefix}-sync-job-dlq-not-empty`,
        metric: syncJobDeadLetterQueue.metricApproximateNumberOfMessagesVisible({
          period: Duration.minutes(5),
          statistic: 'Maximum',
        }),
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      ...autoSleepAlarms,
    ];
    for (const alarm of alarms) {
      alarm.addAlarmAction(new cloudwatchActions.SnsAction(notificationTopic));
    }

    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: `${prefix}-monthly`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: config.monthlyBudgetUsd, unit: 'USD' },
        costFilters: { TagKeyValue: [`user:Environment$${config.environmentName}`] },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            comparisonOperator: 'GREATER_THAN',
            notificationType: 'FORECASTED',
            threshold: 80,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'SNS', address: notificationTopic.topicArn }],
        },
      ],
    });

    const githubProviderArn = isProduction
      ? Arn.format(
          {
            service: 'iam',
            region: '',
            resource: 'oidc-provider',
            resourceName: 'token.actions.githubusercontent.com',
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
          },
          this,
        )
      : new iam.CfnOIDCProvider(this, 'GitHubOidcProvider', {
          url: 'https://token.actions.githubusercontent.com',
          clientIdList: ['sts.amazonaws.com'],
        }).attrArn;
    const githubRole = new iam.Role(this, 'GitHubActionsRole', {
      roleName: `${prefix}-github-actions`,
      description: 'Restricted main-branch deployment role for GitHub Actions OIDC',
      assumedBy: new iam.WebIdentityPrincipal(githubProviderArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: {
          'token.actions.githubusercontent.com:sub': `repo:${config.githubOwner}/${config.githubRepository}:ref:refs/heads/${deploymentBranch}`,
        },
      }),
      maxSessionDuration: Duration.hours(1),
    });
    repository.grantPullPush(githubRole);
    if (isProduction) {
      githubRole.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            'ecr:BatchCheckLayerAvailability',
            'ecr:BatchGetImage',
            'ecr:GetDownloadUrlForLayer',
          ],
          resources: [
            Arn.format(
              {
                service: 'ecr',
                resource: 'repository',
                resourceName: 'oshi-schedule-staging',
                arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
              },
              this,
            ),
          ],
        }),
      );
      githubRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['ecs:DescribeServices'],
          resources: [
            Arn.format(
              {
                service: 'ecs',
                resource: 'service',
                resourceName: 'oshi-schedule-staging-cluster/oshi-schedule-staging-api',
                arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
              },
              this,
            ),
          ],
        }),
      );
    }
    githubRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'ecs:DescribeTaskDefinition',
          'ecs:ListTaskDefinitions',
          'ecs:RegisterTaskDefinition',
          'rds:DescribeDBSnapshots',
        ],
        resources: ['*'],
      }),
    );
    githubRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'ecs:DescribeClusters',
          'ecs:DescribeServices',
          'ecs:DescribeTasks',
          'ecs:RunTask',
          'ecs:UpdateService',
        ],
        resources: [
          cluster.clusterArn,
          apiService.serviceArn,
          Arn.format(
            {
              service: 'ecs',
              resource: 'task-definition',
              resourceName: `${prefix}-*`,
              arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
            },
            this,
          ),
          Arn.format(
            {
              service: 'ecs',
              resource: 'task',
              resourceName: `${cluster.clusterName}/*`,
              arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
            },
            this,
          ),
        ],
      }),
    );
    githubRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:ListTasks'],
        resources: ['*'],
      }),
    );
    githubRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['scheduler:GetSchedule', 'scheduler:UpdateSchedule'],
        resources: [
          Arn.format(
            {
              service: 'scheduler',
              resource: 'schedule',
              resourceName: `default/${prefix}-hourly-worker`,
              arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
            },
            this,
          ),
        ],
      }),
    );
    githubRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [schedulerRole.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' } },
      }),
    );
    githubRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [
          apiTaskDefinition.executionRole!.roleArn,
          apiTaskDefinition.taskRole.roleArn,
          workerTaskDefinition.executionRole!.roleArn,
          workerTaskDefinition.taskRole.roleArn,
          migrationTaskDefinition.executionRole!.roleArn,
          migrationTaskDefinition.taskRole.roleArn,
        ],
        conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
      }),
    );

    const amplifyApp = new amplify.CfnApp(this, 'AmplifyApp', {
      name: `${prefix}-web`,
      description: 'Next.js SSR web application; GitHub connection is completed manually',
      platform: 'WEB_COMPUTE',
      buildSpec: amplifyBuildSpec,
      environmentVariables: [
        { name: '_CUSTOM_IMAGE', value: 'amplify:al2023' },
        { name: 'AMPLIFY_MONOREPO_APP_ROOT', value: 'apps/web' },
        { name: 'WEB_ORIGIN', value: webOrigin },
        {
          name: 'NEXT_PUBLIC_API_URL',
          value: config.apiDomainName ? `https://${config.apiDomainName}` : 'REQUIRED_AT_DEPLOY',
        },
        { name: 'NEXT_PUBLIC_DEMO_MODE', value: 'false' },
        {
          name: 'NEXT_PUBLIC_SUPABASE_URL',
          value: config.nextPublicSupabaseUrl ?? 'REQUIRED_AT_DEPLOY',
        },
        {
          name: 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
          value: config.nextPublicSupabasePublishableKey ?? 'REQUIRED_AT_DEPLOY',
        },
      ],
    });
    githubRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['amplify:GetApp', 'amplify:GetBranch', 'amplify:GetJob', 'amplify:StartJob'],
        resources: [
          Arn.format(
            {
              service: 'amplify',
              resource: 'apps',
              resourceName: `${amplifyApp.attrAppId}/*`,
              arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
            },
            this,
          ),
        ],
      }),
    );
    const createAmplifyBranch = config.amplifyConnectionPhase !== 'detached';
    const createAmplifyDomain = ['manual', 'connected'].includes(config.amplifyConnectionPhase);
    if (createAmplifyBranch) {
      const amplifyBranch = new amplify.CfnBranch(this, 'AmplifyBranch', {
        appId: amplifyApp.attrAppId,
        branchName: deploymentBranch,
        stage: isProduction ? 'PRODUCTION' : 'BETA',
        enableAutoBuild: false,
        enablePullRequestPreview: false,
      });
      if (createAmplifyDomain && config.webDomainName && config.hostedZoneName) {
        const prefixPart =
          config.webDomainName === config.hostedZoneName
            ? ''
            : config.webDomainName.endsWith(`.${config.hostedZoneName}`)
              ? config.webDomainName.slice(0, -(config.hostedZoneName.length + 1))
              : config.webDomainName;
        const amplifyDomain = new amplify.CfnDomain(this, 'AmplifyDomain', {
          appId: amplifyApp.attrAppId,
          domainName: config.hostedZoneName,
          subDomainSettings: [{ branchName: deploymentBranch, prefix: prefixPart }],
        });
        amplifyDomain.addResourceDependency(amplifyBranch);
      }
    }

    new CfnOutput(this, 'EcrRepositoryUri', { value: repository.repositoryUri });
    new CfnOutput(this, 'EcsClusterName', { value: cluster.clusterName });
    new CfnOutput(this, 'ApiServiceName', { value: apiService.serviceName });
    new CfnOutput(this, 'RdsInstanceIdentifier', { value: database.instanceIdentifier });
    new CfnOutput(this, 'WorkerScheduleName', { value: workerSchedule.ref });
    new CfnOutput(this, 'ApplicationActivationParameterName', {
      value: applicationActivationParameter.parameterName,
    });
    if (wakeExpiresAtParameter && autoSleepSchedule) {
      new CfnOutput(this, 'WakeExpiresAtParameterName', {
        value: wakeExpiresAtParameter.parameterName,
      });
      new CfnOutput(this, 'AutoSleepScheduleName', { value: autoSleepSchedule.ref });
    }
    new CfnOutput(this, 'HttpApiId', { value: httpApi.httpApiId });
    new CfnOutput(this, 'VpcLinkId', { value: vpcLink.vpcLinkId });
    new CfnOutput(this, 'CloudMapNamespaceId', { value: namespace.namespaceId });
    new CfnOutput(this, 'CloudMapServiceId', { value: apiDiscoveryService.serviceId });
    new CfnOutput(this, 'SyncJobQueueUrl', { value: syncJobQueue.queueUrl });
    new CfnOutput(this, 'SyncJobPipeName', { value: syncPipe.name! });
    if (config.apiDomainName) {
      new CfnOutput(this, 'ApiUrl', { value: `https://${config.apiDomainName}` });
    }
    if (config.webDomainName) {
      new CfnOutput(this, 'WebUrl', { value: `https://${config.webDomainName}` });
    }
    new CfnOutput(this, 'WorkerTaskDefinitionArn', {
      value: workerTaskDefinition.taskDefinitionArn,
    });
    new CfnOutput(this, 'MigrationTaskDefinitionArn', {
      value: migrationTaskDefinition.taskDefinitionArn,
    });
    new CfnOutput(this, 'AmplifyAppId', { value: amplifyApp.attrAppId });
    new CfnOutput(this, 'AmplifyBranchName', { value: deploymentBranch });
    new CfnOutput(this, 'GitHubActionsRoleArn', { value: githubRole.roleArn });
  }
}
