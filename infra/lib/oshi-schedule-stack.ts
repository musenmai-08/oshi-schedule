import {
  Arn,
  ArnFormat,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Tags,
  aws_amplify as amplify,
  aws_budgets as budgets,
  aws_certificatemanager as acm,
  aws_cloudwatch as cloudwatch,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_events as events,
  aws_iam as iam,
  aws_logs as logs,
  aws_rds as rds,
  aws_route53 as route53,
  aws_route53_targets as route53Targets,
  aws_scheduler as scheduler,
  aws_secretsmanager as secretsmanager,
  aws_sns as sns,
  aws_sns_subscriptions as subscriptions,
  aws_sqs as sqs,
  aws_ssm as ssm,
} from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { DeploymentConfig } from './config.js';

interface OshiScheduleStackProps extends StackProps {
  config: DeploymentConfig;
}

export class OshiScheduleStack extends Stack {
  constructor(scope: Construct, id: string, props: OshiScheduleStackProps) {
    super(scope, id, props);

    const { config } = props;
    const prefix = `oshi-schedule-${config.environmentName}`;
    const isProduction = config.environmentName === 'production';
    const webOrigin = config.webDomainName
      ? `https://${config.webDomainName}`
      : 'https://domain-required.invalid';

    Tags.of(this).add('Application', 'oshi-schedule');
    Tags.of(this).add('Environment', config.environmentName);
    Tags.of(this).add('ManagedBy', 'aws-cdk');

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

    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      description: 'Public ingress to the application load balancer',
      allowAllOutbound: true,
    });
    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP redirect or TLS-required response');
    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');

    const apiSecurityGroup = new ec2.SecurityGroup(this, 'ApiSecurityGroup', {
      vpc,
      description: 'API tasks accept traffic only from the ALB',
      allowAllOutbound: true,
    });
    apiSecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(4000), 'ALB to API');
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
    databaseSecurityGroup.addIngressRule(workerSecurityGroup, ec2.Port.tcp(3306), 'Worker and migration to MySQL');

    const databaseEngine = rds.DatabaseInstanceEngine.mysql({
      version: rds.MysqlEngineVersion.of('8.4.6', '8.4'),
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
      cloudwatchLogsRetention: isProduction ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.TWO_WEEKS,
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
      YOUTUBE_DAILY_SEARCH_QUOTA_BUDGET: new ssm.StringParameter(this, 'SearchQuotaBudgetParameter', {
        parameterName: `/${prefix}/runtime/youtube-daily-search-quota-budget`,
        stringValue: '80',
      }),
    };
    const referencedParameters = {
      ALLOWED_EMAILS: ssm.StringParameter.fromStringParameterAttributes(
        this,
        'AllowedEmailsParameter',
        { parameterName: `/${prefix}/runtime/allowed-emails`, simpleName: false },
      ),
      SUPABASE_URL: ssm.StringParameter.fromStringParameterAttributes(
        this,
        'SupabaseUrlParameter',
        { parameterName: `/${prefix}/runtime/supabase-url`, simpleName: false },
      ),
      GOOGLE_CLIENT_ID: ssm.StringParameter.fromStringParameterAttributes(
        this,
        'GoogleClientIdParameter',
        { parameterName: `/${prefix}/runtime/google-client-id`, simpleName: false },
      ),
    };
    const referencedSecrets = {
      SUPABASE_SERVICE_ROLE_KEY: secretsmanager.Secret.fromSecretNameV2(
        this,
        'SupabaseServiceRoleSecret',
        `${prefix}/app/supabase-service-role-key`,
      ),
      GOOGLE_CLIENT_SECRET: secretsmanager.Secret.fromSecretNameV2(
        this,
        'GoogleClientSecret',
        `${prefix}/app/google-client-secret`,
      ),
      YOUTUBE_API_KEY: secretsmanager.Secret.fromSecretNameV2(
        this,
        'YoutubeApiKeySecret',
        `${prefix}/app/youtube-api-key`,
      ),
      TOKEN_ENCRYPTION_KEYS: secretsmanager.Secret.fromSecretNameV2(
        this,
        'TokenEncryptionKeysSecret',
        `${prefix}/app/token-encryption-keys`,
      ),
    };

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
    const applicationSecrets: Record<string, ecs.Secret> = {
      ...databaseSecrets,
      ...Object.fromEntries(
        Object.entries(runtimeParameters).map(([name, parameter]) => [name, ecs.Secret.fromSsmParameter(parameter)]),
      ),
      ...Object.fromEntries(
        Object.entries(referencedParameters).map(([name, parameter]) => [name, ecs.Secret.fromSsmParameter(parameter)]),
      ),
      ...Object.fromEntries(
        Object.entries(referencedSecrets).map(([name, secret]) => [name, ecs.Secret.fromSecretsManager(secret)]),
      ),
    };

    const apiTaskDefinition = new ecs.FargateTaskDefinition(this, 'ApiTaskDefinition', {
      family: `${prefix}-api`,
      cpu: config.apiCpu,
      memoryLimitMiB: config.apiMemoryMiB,
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
        ...databaseEnvironment,
      },
      secrets: applicationSecrets,
    });
    apiContainer.addPortMappings({ containerPort: 4000, protocol: ecs.Protocol.TCP });

    const apiService = new ecs.FargateService(this, 'ApiService', {
      serviceName: `${prefix}-api`,
      cluster,
      taskDefinition: apiTaskDefinition,
      desiredCount: 1,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [apiSecurityGroup],
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      enableExecuteCommand: false,
    });

    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      loadBalancerName: `${prefix}-alb`,
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'ApiTargetGroup', {
      vpc,
      targetType: elbv2.TargetType.IP,
      port: 4000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      deregistrationDelay: Duration.seconds(60),
      healthCheck: { path: '/health', healthyHttpCodes: '200', interval: Duration.seconds(30) },
      targets: [apiService.loadBalancerTarget({ containerName: 'api', containerPort: 4000 })],
    });

    if (config.certificateArn && config.apiDomainName && config.hostedZoneId && config.hostedZoneName) {
      const certificate = acm.Certificate.fromCertificateArn(this, 'ApiCertificate', config.certificateArn);
      const httpsListener = loadBalancer.addListener('HttpsListener', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [certificate],
        defaultTargetGroups: [targetGroup],
      });
      httpsListener.setAttribute('routing.http.drop_invalid_header_fields.enabled', 'true');
      loadBalancer.addListener('HttpListener', {
        port: 80,
        defaultAction: elbv2.ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true }),
      });
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: config.hostedZoneId,
        zoneName: config.hostedZoneName,
      });
      new route53.ARecord(this, 'ApiAliasRecord', {
        zone,
        recordName: config.apiDomainName,
        target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(loadBalancer)),
      });
    } else {
      loadBalancer.addListener('TlsRequiredListener', {
        port: 80,
        defaultAction: elbv2.ListenerAction.fixedResponse(503, {
          contentType: 'application/json',
          messageBody: '{"error":"TLS configuration required"}',
        }),
      });
    }

    const workerTaskDefinition = new ecs.FargateTaskDefinition(this, 'WorkerTaskDefinition', {
      family: `${prefix}-worker`,
      cpu: config.workerCpu,
      memoryLimitMiB: config.workerMemoryMiB,
    });
    workerTaskDefinition.addContainer('worker', {
      containerName: 'worker',
      image,
      command: ['node', 'worker/dist/index.js'],
      essential: true,
      logging: ecs.LogDrivers.awsLogs({ logGroup: workerLogGroup, streamPrefix: 'worker' }),
      environment: { NODE_ENV: 'production', ...databaseEnvironment },
      secrets: applicationSecrets,
    });

    const migrationTaskDefinition = new ecs.FargateTaskDefinition(this, 'MigrationTaskDefinition', {
      family: `${prefix}-migration`,
      cpu: 256,
      memoryLimitMiB: 512,
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
    new scheduler.CfnSchedule(this, 'WorkerSchedule', {
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

    notificationTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('events.amazonaws.com')],
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
          taskDefinitionArn: [{ prefix: workerTaskDefinition.taskDefinitionArn }],
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
      new cloudwatch.Alarm(this, 'Alb5xxAlarm', {
        alarmName: `${prefix}-alb-5xx`,
        metric: loadBalancer.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, {
          period: Duration.minutes(5),
        }),
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
    ];
    for (const alarm of alarms) {
      alarm.addAlarmAction({ bind: () => ({ alarmActionArn: notificationTopic.topicArn }) });
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
          'token.actions.githubusercontent.com:sub':
            `repo:${config.githubOwner}/${config.githubRepository}:ref:refs/heads/main`,
        },
      }),
      maxSessionDuration: Duration.hours(1),
    });
    repository.grantPullPush(githubRole);
    if (isProduction) {
      githubRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['ecr:BatchCheckLayerAvailability', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
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
          'ecs:ListTasks',
          'ecs:RunTask',
          'ecs:UpdateService',
        ],
        resources: [
          cluster.clusterArn,
          apiService.serviceArn,
          Arn.format({ service: 'ecs', resource: 'task-definition', resourceName: `${prefix}-*`, arnFormat: ArnFormat.SLASH_RESOURCE_NAME }, this),
          Arn.format({ service: 'ecs', resource: 'task', resourceName: `${cluster.clusterName}/*`, arnFormat: ArnFormat.SLASH_RESOURCE_NAME }, this),
        ],
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
      buildSpec: [
        'version: 1',
        'applications:',
        '  - appRoot: apps/web',
        '    frontend:',
        '      phases:',
        '        preBuild:',
        '          commands:',
        '            - corepack enable',
        '            - corepack prepare pnpm@9.15.9 --activate',
        '            - pnpm install --frozen-lockfile',
        '        build:',
        '          commands:',
        '            - pnpm --filter @oshi-schedule/web build',
        '      artifacts:',
        '        baseDirectory: apps/web/.next',
        '        files:',
        '          - "**/*"',
        '      cache:',
        '        paths:',
        '          - node_modules/.pnpm/**/*',
        '          - apps/web/.next/cache/**/*',
      ].join('\n'),
      environmentVariables: [
        { name: '_CUSTOM_IMAGE', value: 'amplify:al2023' },
        { name: 'AMPLIFY_MONOREPO_APP_ROOT', value: 'apps/web' },
        { name: 'NEXT_PUBLIC_API_URL', value: config.apiDomainName ? `https://${config.apiDomainName}` : 'REQUIRED_AT_DEPLOY' },
        { name: 'NEXT_PUBLIC_DEMO_MODE', value: 'false' },
        { name: 'NEXT_PUBLIC_SUPABASE_URL', value: config.nextPublicSupabaseUrl ?? 'REQUIRED_AT_DEPLOY' },
        { name: 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', value: config.nextPublicSupabasePublishableKey ?? 'REQUIRED_AT_DEPLOY' },
      ],
    });
    const amplifyBranch = new amplify.CfnBranch(this, 'AmplifyBranch', {
      appId: amplifyApp.attrAppId,
      branchName: config.environmentName,
      stage: isProduction ? 'PRODUCTION' : 'BETA',
      enableAutoBuild: false,
      enablePullRequestPreview: false,
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
    if (config.webDomainName && config.hostedZoneName) {
      const prefixPart = config.webDomainName.endsWith(`.${config.hostedZoneName}`)
        ? config.webDomainName.slice(0, -(config.hostedZoneName.length + 1))
        : config.webDomainName;
      new amplify.CfnDomain(this, 'AmplifyDomain', {
        appId: amplifyApp.attrAppId,
        domainName: config.hostedZoneName,
        subDomainSettings: [{ branchName: amplifyBranch.branchName, prefix: prefixPart }],
      });
    }

    new CfnOutput(this, 'EcrRepositoryUri', { value: repository.repositoryUri });
    new CfnOutput(this, 'EcsClusterName', { value: cluster.clusterName });
    new CfnOutput(this, 'ApiServiceName', { value: apiService.serviceName });
    new CfnOutput(this, 'WorkerTaskDefinitionArn', { value: workerTaskDefinition.taskDefinitionArn });
    new CfnOutput(this, 'MigrationTaskDefinitionArn', { value: migrationTaskDefinition.taskDefinitionArn });
    new CfnOutput(this, 'AmplifyAppId', { value: amplifyApp.attrAppId });
    new CfnOutput(this, 'AmplifyBranchName', { value: amplifyBranch.branchName });
    new CfnOutput(this, 'GitHubActionsRoleArn', { value: githubRole.roleArn });
  }
}
