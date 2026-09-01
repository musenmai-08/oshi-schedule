import {
  Arn,
  ArnFormat,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Tags,
  type StackProps,
} from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as amplify from 'aws-cdk-lib/aws-amplify';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Construct } from 'constructs';
import { applicationSecretArnDefinitions, type DeploymentConfig } from './config.js';

interface ServerlessStackProps extends StackProps {
  config: DeploymentConfig;
}

const findRepositoryFile = (relative: string) => {
  const candidates = [
    new URL(`../../${relative}`, import.meta.url),
    new URL(`../../../${relative}`, import.meta.url),
  ];
  const path = candidates.map((candidate) => fileURLToPath(candidate)).find(existsSync);
  if (!path) throw new Error(`Repository file was not found: ${relative}`);
  return path;
};

export const lambdaBundling: lambdaNodejs.BundlingOptions = {
  format: lambdaNodejs.OutputFormat.ESM,
  target: 'node22',
  minify: true,
  sourceMap: true,
  // Prisma and serverless-express retain CommonJS dynamic requires. In an ESM
  // Lambda bundle, supply Node's scoped require rather than esbuild's throwing
  // browser fallback (for example, dynamic require of "util").
  banner: 'import { createRequire } from "node:module";const require = createRequire(import.meta.url);',
  externalModules: ['@prisma/client', '.prisma/client'],
  commandHooks: {
    beforeBundling: () => [],
    beforeInstall: () => [],
    afterBundling: (inputDir: string, outputDir: string) => [
      `mkdir -p ${outputDir}/node_modules/@prisma ${outputDir}/node_modules/.prisma`,
      `cp -RL ${inputDir}/node_modules/@prisma/client ${outputDir}/node_modules/@prisma/client`,
      `cp -RL ${inputDir}/node_modules/.prisma/client ${outputDir}/node_modules/.prisma/client`,
      `test -f ${outputDir}/node_modules/.prisma/client/libquery_engine-rhel-openssl-3.0.x.so.node`,
      `rm -f ${outputDir}/node_modules/.prisma/client/libquery_engine-darwin-*.dylib.node`,
    ],
  },
};

export class ServerlessOshiScheduleStack extends Stack {
  constructor(scope: Construct, id: string, props: ServerlessStackProps) {
    super(scope, id, props);

    const { config } = props;
    const prefix = `oshi-schedule-${config.environmentName}`;
    const isProduction = config.environmentName === 'production';
    const isStagingPreview =
      config.environmentName === 'staging' && config.serverlessStagingMode === 'preview';
    const resourcePrefix = isStagingPreview ? `${prefix}-serverless` : prefix;
    const removalPolicy = isProduction ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const logRetention = isProduction ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.TWO_WEEKS;
    const repositoryRoot = findRepositoryFile('package.json').replace(/\/package\.json$/, '');
    const webOrigin = config.webDomainName
      ? `https://${config.webDomainName}`
      : 'https://domain-required.invalid';

    Tags.of(this).add('Application', 'oshi-schedule');
    Tags.of(this).add('Environment', config.environmentName);
    Tags.of(this).add('ManagedBy', 'aws-cdk');

    // Retain the bootstrap repository under the same logical ID. Lambda no longer
    // consumes it, but removing it requires a separate, explicit cleanup approval.
    const repository = isStagingPreview
      ? undefined
      : new ecr.Repository(this, 'Repository', {
          repositoryName: resourcePrefix,
          imageScanOnPush: true,
          imageTagMutability: ecr.TagMutability.IMMUTABLE,
          lifecycleRules: [{ maxImageCount: isProduction ? 50 : 20 }],
          removalPolicy: RemovalPolicy.RETAIN,
          emptyOnDelete: false,
        });
    new CfnOutput(this, 'EnvironmentName', { value: config.environmentName });
    if (repository) new CfnOutput(this, 'EcrRepositoryUri', { value: repository.repositoryUri });
    if (config.bootstrapOnly) return;

    const alerts = new sns.Topic(this, 'Alerts', {
      topicName: `${resourcePrefix}-alerts`,
      displayName: `${resourcePrefix} operational alerts`,
    });
    if (config.alertEmail)
      alerts.addSubscription(new subscriptions.EmailSubscription(config.alertEmail));

    const syncDlq = new sqs.Queue(this, 'SyncJobDeadLetterQueue', {
      queueName: `${resourcePrefix}-sync-jobs-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      removalPolicy,
    });
    const syncQueue = new sqs.Queue(this, 'SyncJobQueue', {
      queueName: `${resourcePrefix}-sync-jobs`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(4),
      visibilityTimeout: Duration.minutes(90),
      deadLetterQueue: { queue: syncDlq, maxReceiveCount: 3 },
      removalPolicy,
    });
    const schedulerDlq = new sqs.Queue(this, 'SchedulerDeadLetterQueue', {
      queueName: `${resourcePrefix}-scheduler-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      removalPolicy,
    });

    const rateLimitTable = new dynamodb.Table(this, 'RateLimitTable', {
      tableName: `${resourcePrefix}-rate-limits`,
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
      removalPolicy,
    });

    const applicationSecretArns = applicationSecretArnDefinitions.map(
      (definition) =>
        config[definition.contextKey] ??
        `arn:aws:secretsmanager:${config.region}:${config.account ?? '000000000000'}:secret:${prefix}/${definition.secretNameSuffix}-000000`,
    );
    const databaseUrlSecretArn =
      config.databaseUrlSecretArn ??
      `arn:aws:secretsmanager:${config.region}:${config.account ?? '000000000000'}:secret:${prefix}/app/database-runtime-url-000000`;
    const databaseMigrationUrlSecretArn =
      config.databaseMigrationUrlSecretArn ??
      `arn:aws:secretsmanager:${config.region}:${config.account ?? '000000000000'}:secret:${prefix}/app/database-migration-url-000000`;
    const allowedEmailsName = `/${prefix}/runtime/allowed-emails`;
    const secretEnvironment = {
      DATABASE_URL_SECRET_ARN: databaseUrlSecretArn,
      GOOGLE_CLIENT_SECRET_SECRET_ARN: applicationSecretArns[1]!,
      YOUTUBE_API_KEY_SECRET_ARN: applicationSecretArns[2]!,
      TOKEN_ENCRYPTION_KEYS_SECRET_ARN: applicationSecretArns[3]!,
    };
    const sharedEnvironment = {
      NODE_ENV: 'production',
      APP_MODE: 'real',
      GOOGLE_CLIENT_ID: config.googleClientId ?? 'REQUIRED_AT_DEPLOY',
      YOUTUBE_QUOTA_TIMEZONE: 'America/Los_Angeles',
      ...secretEnvironment,
    };

    const workerFunction = new lambdaNodejs.NodejsFunction(this, 'WorkerFunction', {
      functionName: `${resourcePrefix}-worker`,
      entry: `${repositoryRoot}/apps/worker/src/lambda.ts`,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.X86_64,
      memorySize: 512,
      timeout: Duration.minutes(14),
      logGroup: new logs.LogGroup(this, 'WorkerLogGroup', {
        logGroupName: `/oshi-schedule/${isStagingPreview ? 'staging-serverless' : config.environmentName}/worker`,
        retention: logRetention,
        removalPolicy,
      }),
      environment: sharedEnvironment,
      bundling: lambdaBundling,
      depsLockFilePath: `${repositoryRoot}/pnpm-lock.yaml`,
      projectRoot: repositoryRoot,
    });
    workerFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(syncQueue, {
        batchSize: 1,
        maxConcurrency: 2,
        reportBatchItemFailures: true,
      }),
    );

    const apiFunction = new lambdaNodejs.NodejsFunction(this, 'ApiFunction', {
      functionName: `${resourcePrefix}-api`,
      entry: `${repositoryRoot}/apps/api/src/lambda.ts`,
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.X86_64,
      memorySize: 512,
      timeout: Duration.seconds(29),
      logGroup: new logs.LogGroup(this, 'ApiLogGroup', {
        logGroupName: `/oshi-schedule/${isStagingPreview ? 'staging-serverless' : config.environmentName}/api`,
        retention: logRetention,
        removalPolicy,
      }),
      environment: {
        ...sharedEnvironment,
        WEB_ORIGIN: webOrigin,
        SUPABASE_URL: config.nextPublicSupabaseUrl ?? 'REQUIRED_AT_DEPLOY',
        SUPABASE_JWT_AUDIENCE: 'authenticated',
        SUPABASE_SERVICE_ROLE_KEY_SECRET_ARN: applicationSecretArns[0]!,
        ALLOWED_EMAILS_PARAMETER_NAME: allowedEmailsName,
        SYNC_JOB_QUEUE_URL: syncQueue.queueUrl,
        RATE_LIMIT_TABLE_NAME: rateLimitTable.tableName,
      },
      bundling: lambdaBundling,
      depsLockFilePath: `${repositoryRoot}/pnpm-lock.yaml`,
      projectRoot: repositoryRoot,
    });

    workerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          databaseUrlSecretArn,
          applicationSecretArns[1]!,
          applicationSecretArns[2]!,
          applicationSecretArns[3]!,
        ],
      }),
    );
    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [databaseUrlSecretArn, ...applicationSecretArns],
      }),
    );
    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          Arn.format(
            {
              service: 'ssm',
              resource: 'parameter',
              resourceName: allowedEmailsName.replace(/^\//, ''),
              arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
            },
            this,
          ),
        ],
      }),
    );
    syncQueue.grantSendMessages(apiFunction);
    rateLimitTable.grantReadWriteData(apiFunction);

    const workerSchedule = new scheduler.Schedule(this, 'WorkerSchedule', {
      scheduleName: `${resourcePrefix}-hourly-worker`,
      schedule: scheduler.ScheduleExpression.rate(Duration.hours(1)),
      enabled: config.workerScheduleEnabled,
      target: new schedulerTargets.SqsSendMessage(syncQueue, {
        input: scheduler.ScheduleTargetInput.fromObject({ kind: 'scheduled' }),
        deadLetterQueue: schedulerDlq,
        retryAttempts: 2,
        maxEventAge: Duration.hours(1),
      }),
    });

    const httpApiLogGroup = new logs.LogGroup(this, 'HttpApiLogGroup', {
      logGroupName: `/aws/apigateway/${resourcePrefix}-http-api`,
      retention: logRetention,
      removalPolicy,
    });
    let apiDomain: apigatewayv2.DomainName | undefined;
    let hostedZone: route53.IHostedZone | undefined;
    if (
      !isStagingPreview &&
      config.certificateArn &&
      config.apiDomainName &&
      config.hostedZoneId &&
      config.hostedZoneName
    ) {
      apiDomain = new apigatewayv2.DomainName(this, 'ApiDomainName', {
        domainName: config.apiDomainName,
        certificate: acm.Certificate.fromCertificateArn(
          this,
          'ApiCertificate',
          config.certificateArn,
        ),
        endpointType: apigatewayv2.EndpointType.REGIONAL,
        securityPolicy: apigatewayv2.SecurityPolicy.TLS_1_2,
      });
      hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: config.hostedZoneId,
        zoneName: config.hostedZoneName,
      });
    }
    const httpApi = new apigatewayv2.HttpApi(this, 'HttpApi', {
      apiName: `${resourcePrefix}-api`,
      description: 'Lambda proxy for the oshi-schedule API',
      disableExecuteApiEndpoint: Boolean(apiDomain),
      defaultDomainMapping: apiDomain ? { domainName: apiDomain } : undefined,
      defaultIntegration: new integrations.HttpLambdaIntegration('ApiIntegration', apiFunction, {
        timeout: Duration.seconds(29),
      }),
    });
    const stage = httpApi.defaultStage?.node.defaultChild as apigatewayv2.CfnStage;
    stage.defaultRouteSettings = { throttlingBurstLimit: 100, throttlingRateLimit: 50 };
    stage.accessLogSettings = {
      destinationArn: httpApiLogGroup.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId',
        sourceIp: '$context.identity.sourceIp',
        routeKey: '$context.routeKey',
        status: '$context.status',
        integrationStatus: '$context.integration.status',
        integrationLatency: '$context.integration.latency',
      }),
    };
    if (apiDomain && hostedZone && config.apiDomainName)
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

    const backupBucket = new s3.Bucket(this, 'DatabaseBackupBucket', {
      bucketName: config.account ? `${resourcePrefix}-database-backups-${config.account}` : undefined,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      lifecycleRules: [
        {
          id: 'expire-database-backups',
          enabled: true,
          expiration: Duration.days(config.backupRetentionDays),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
      // Preview rollback must not leave an empty named bucket that prevents the
      // next CloudFormation create. Production backups remain retained.
      removalPolicy,
      autoDeleteObjects: false,
    });

    const githubProviderArn = Arn.format(
      {
        service: 'iam',
        region: '',
        resource: 'oidc-provider',
        resourceName: 'token.actions.githubusercontent.com',
        arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
      },
      this,
    );
    const backupRole = new iam.Role(this, 'DatabaseBackupRole', {
      roleName: `${resourcePrefix}-database-backup`,
      assumedBy: new iam.WebIdentityPrincipal(githubProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `repo:${config.githubOwner}/${config.githubRepository}:environment:${config.environmentName}-backup`,
        },
      }),
      maxSessionDuration: Duration.hours(1),
    });
    backupBucket.grantReadWrite(backupRole, 'database/*');
    backupRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [databaseMigrationUrlSecretArn],
      }),
    );

    if (!isStagingPreview) {
      const amplifyBuildSpec = readFileSync(findRepositoryFile('amplify.yml'), 'utf8').trimEnd();
      const amplifyApp = new amplify.CfnApp(this, 'AmplifyApp', {
        name: `${resourcePrefix}-web`,
        description: 'Next.js SSR web application',
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
      const createBranch = config.amplifyConnectionPhase !== 'detached';
      const createDomain = ['manual', 'connected'].includes(config.amplifyConnectionPhase);
      if (createBranch) {
        const branch = new amplify.CfnBranch(this, 'AmplifyBranch', {
          appId: amplifyApp.attrAppId,
          branchName: 'main',
          stage: isProduction ? 'PRODUCTION' : 'BETA',
          enableAutoBuild: false,
          enablePullRequestPreview: false,
        });
        if (createDomain && config.webDomainName && config.hostedZoneName) {
          const prefixPart =
            config.webDomainName === config.hostedZoneName
              ? ''
              : config.webDomainName.replace(`.${config.hostedZoneName}`, '');
          const domain = new amplify.CfnDomain(this, 'AmplifyDomain', {
            appId: amplifyApp.attrAppId,
            domainName: config.hostedZoneName,
            subDomainSettings: [{ branchName: 'main', prefix: prefixPart }],
          });
          domain.addResourceDependency(branch);
        }
      }
    }

    for (const alarm of [
      new cloudwatch.Alarm(this, 'ApiErrorsAlarm', {
        metric: apiFunction.metricErrors({ period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'WorkerErrorsAlarm', {
        metric: workerFunction.metricErrors({ period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'WorkerDurationAlarm', {
        metric: workerFunction.metricDuration({ period: Duration.minutes(5) }),
        threshold: Duration.minutes(10).toMilliseconds(),
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      new cloudwatch.Alarm(this, 'SyncDlqAlarm', {
        metric: syncDlq.metricApproximateNumberOfMessagesVisible(),
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    ])
      alarm.addAlarmAction(new cloudwatchActions.SnsAction(alerts));

    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: `${resourcePrefix}-monthly`,
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
          subscribers: [{ subscriptionType: 'SNS', address: alerts.topicArn }],
        },
      ],
    });

    new CfnOutput(this, 'HttpApiId', { value: httpApi.httpApiId });
    new CfnOutput(this, 'SyncJobQueueUrl', { value: syncQueue.queueUrl });
    new CfnOutput(this, 'WorkerScheduleName', { value: workerSchedule.scheduleName });
    new CfnOutput(this, 'ApiFunctionName', { value: apiFunction.functionName });
    new CfnOutput(this, 'WorkerFunctionName', { value: workerFunction.functionName });
    new CfnOutput(this, 'DatabaseBackupBucketName', { value: backupBucket.bucketName });
    new CfnOutput(this, 'DatabaseBackupRoleArn', { value: backupRole.roleArn });
    if (config.apiDomainName)
      new CfnOutput(this, 'ApiUrl', { value: `https://${config.apiDomainName}` });
    if (config.webDomainName)
      new CfnOutput(this, 'WebUrl', { value: `https://${config.webDomainName}` });
  }
}
