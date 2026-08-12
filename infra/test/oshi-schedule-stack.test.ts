import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { loadConfig, type DeploymentConfig, type EnvironmentName } from '../lib/config.js';
import { OshiScheduleStack } from '../lib/oshi-schedule-stack.js';

const fullStagingContext: Record<string, unknown> = {
  environment: 'staging',
  deployReady: 'true',
  bootstrapOnly: 'false',
  awsAccount: '111111111111',
  awsRegion: 'ap-northeast-1',
  hostedZoneId: 'Z00000000000000000000',
  hostedZoneName: 'example.invalid',
  webDomainName: 'staging.example.invalid',
  apiDomainName: 'api.staging.example.invalid',
  certificateArn:
    'arn:aws:acm:ap-northeast-1:111111111111:certificate/00000000-0000-4000-8000-000000000000',
  alertEmail: 'synth-only@example.invalid',
  nextPublicSupabaseUrl: 'https://supabase.example.invalid',
  nextPublicSupabasePublishableKey: 'sb_publishable_synth_only',
  githubOwner: 'example-owner',
  githubRepository: 'oshi-schedule',
  imageTag: 'sha-0123456789abcdef',
};

const configFor = (environmentName: EnvironmentName): DeploymentConfig => ({
  environmentName,
  account: '111111111111',
  region: 'ap-northeast-1',
  deployReady: false,
  bootstrapOnly: false,
  monthlyBudgetUsd: environmentName === 'staging' ? 25 : 75,
  githubOwner: 'example-owner',
  githubRepository: 'oshi-schedule',
  imageTag: 'sha-0123456789abcdef',
  apiCpu: 256,
  apiMemoryMiB: 512,
  workerCpu: 256,
  workerMemoryMiB: 512,
  rdsInstanceType: 't4g.micro',
  rdsAllocatedStorageGiB: 20,
  rdsBackupRetentionDays: 1,
  rdsMultiAz: false,
  rdsDeletionProtection: true,
  workerScheduleEnabled: false,
});

const render = (environmentName: EnvironmentName = 'staging'): Template => {
  const app = new App();
  const stack = new OshiScheduleStack(app, `test-${environmentName}`, {
    env: { account: '111111111111', region: 'ap-northeast-1' },
    config: configFor(environmentName),
  });
  return Template.fromStack(stack);
};

const renderFromCliContext = (context: Record<string, unknown>): Template => {
  const app = new App({ context });
  const config = loadConfig(app);
  return Template.fromStack(
    new OshiScheduleStack(app, `cli-${config.environmentName}`, {
      env: { account: config.account, region: config.region },
      config,
    }),
  );
};

describe('OshiScheduleStack', () => {
  it('supports an ECR-first bootstrap from CLI string context without full-stack resources', () => {
    const template = renderFromCliContext({
      environment: 'staging',
      deployReady: 'true',
      bootstrapOnly: 'true',
      awsAccount: '111111111111',
      awsRegion: 'ap-northeast-1',
    });
    template.resourceCountIs('AWS::EC2::VPC', 1);
    template.resourceCountIs('AWS::ECR::Repository', 1);
    template.resourceCountIs('AWS::ECS::Service', 0);
    template.resourceCountIs('AWS::RDS::DBInstance', 0);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 0);
    template.resourceCountIs('AWS::ApiGatewayV2::VpcLink', 0);
    template.resourceCountIs('AWS::ServiceDiscovery::PrivateDnsNamespace', 0);
    template.resourceCountIs('AWS::Pipes::Pipe', 0);
    template.resourceCountIs('AWS::Amplify::App', 0);
    template.resourceCountIs('AWS::Scheduler::Schedule', 0);
    template.resourceCountIs('AWS::Lambda::Function', 0);
    template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
    template.resourceCountIs('AWS::Budgets::Budget', 0);
    template.resourceCountIs('AWS::SecretsManager::Secret', 0);
    template.resourceCountIs('AWS::SSM::Parameter', 0);
    template.hasOutput('EnvironmentName', { Value: 'staging' });
  });

  it('synthesizes full staging resources from CLI string context', () => {
    const template = renderFromCliContext(fullStagingContext);
    template.resourceCountIs('AWS::ECS::Service', 1);
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 0);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 0);
    template.resourceCountIs('AWS::S3::Bucket', 0);
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    template.resourceCountIs('AWS::ApiGatewayV2::VpcLink', 1);
    template.resourceCountIs('AWS::ServiceDiscovery::PrivateDnsNamespace', 1);
    template.resourceCountIs('AWS::ServiceDiscovery::Service', 1);
    template.resourceCountIs('AWS::Pipes::Pipe', 1);
    template.resourceCountIs('AWS::Amplify::App', 1);
    template.resourceCountIs('AWS::Scheduler::Schedule', 2);
    template.resourceCountIs('AWS::Budgets::Budget', 1);
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({
        BudgetLimit: { Amount: 25, Unit: 'USD' },
        CostFilters: { TagKeyValue: ['user:Environment$staging'] },
      }),
      NotificationsWithSubscribers: Match.arrayWith([
        Match.objectLike({
          Notification: Match.objectLike({
            NotificationType: 'FORECASTED',
            Threshold: 80,
            ThresholdType: 'PERCENTAGE',
          }),
        }),
      ]),
    });
    for (const output of [
      'EnvironmentName',
      'EcsClusterName',
      'ApiServiceName',
      'RdsInstanceIdentifier',
      'WorkerScheduleName',
      'WakeExpiresAtParameterName',
      'AutoSleepScheduleName',
      'HttpApiId',
      'VpcLinkId',
      'CloudMapNamespaceId',
      'CloudMapServiceId',
      'SyncJobQueueUrl',
      'SyncJobPipeName',
      'ApiUrl',
      'WebUrl',
      'AmplifyAppId',
    ]) {
      template.hasOutput(output, {});
    }
  });

  it('connects the staging domain to the main Amplify source branch without application secrets', () => {
    const template = renderFromCliContext(fullStagingContext);
    template.resourceCountIs('AWS::Amplify::App', 1);
    template.resourceCountIs('AWS::Amplify::Branch', 1);
    template.resourceCountIs('AWS::Amplify::Domain', 1);
    template.hasResourceProperties('AWS::Amplify::Branch', { BranchName: 'main' });
    template.hasResourceProperties('AWS::Amplify::Domain', {
      DomainName: 'example.invalid',
      SubDomainSettings: [{ BranchName: 'main', Prefix: 'staging' }],
    });

    const app = Object.values(template.findResources('AWS::Amplify::App'))[0];
    expect(app).toBeDefined();
    const environmentNames = (app!.Properties?.EnvironmentVariables as Array<{ Name: string }>).map(
      ({ Name }) => Name,
    );
    expect(environmentNames.sort()).toEqual(
      [
        'AMPLIFY_MONOREPO_APP_ROOT',
        'NEXT_PUBLIC_API_URL',
        'NEXT_PUBLIC_DEMO_MODE',
        'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
        'NEXT_PUBLIC_SUPABASE_URL',
        '_CUSTOM_IMAGE',
      ].sort(),
    );
    expect(environmentNames).not.toEqual(
      expect.arrayContaining([
        'GOOGLE_CLIENT_SECRET',
        'SUPABASE_SERVICE_ROLE_KEY',
        'TOKEN_ENCRYPTION_KEYS',
        'YOUTUBE_API_KEY',
      ]),
    );
  });

  it('does not expose full-stack operation outputs during bootstrap-only synth', () => {
    const template = renderFromCliContext({
      environment: 'staging',
      deployReady: 'true',
      bootstrapOnly: 'true',
      awsAccount: '111111111111',
      awsRegion: 'ap-northeast-1',
    });
    for (const output of [
      'EcsClusterName',
      'ApiServiceName',
      'RdsInstanceIdentifier',
      'WorkerScheduleName',
      'WakeExpiresAtParameterName',
      'AutoSleepScheduleName',
      'HttpApiId',
      'ApiUrl',
      'WebUrl',
      'AmplifyAppId',
    ]) {
      expect(template.toJSON().Outputs?.[output]).toBeUndefined();
    }
  });

  it('applies RDS and worker CLI boolean strings to the template', () => {
    const template = renderFromCliContext({
      ...fullStagingContext,
      rdsMultiAz: 'true',
      rdsDeletionProtection: 'false',
      workerScheduleEnabled: 'true',
    });
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      MultiAZ: true,
      DeletionProtection: false,
    });
    template.hasResourceProperties('AWS::Scheduler::Schedule', { State: 'ENABLED' });
  });

  it('uses public compute subnets without NAT and keeps RDS private', () => {
    const template = render();
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      PubliclyAccessible: false,
      MultiAZ: false,
      AllocatedStorage: '20',
      DeletionProtection: true,
      Engine: 'mysql',
      EngineVersion: '8.4.10',
    });
    template.hasResourceProperties('AWS::RDS::DBSubnetGroup', {
      DBSubnetGroupDescription: Match.anyValue(),
    });
  });

  it('runs one circuit-broken API service with public-IP egress and SRV discovery', () => {
    const template = render();
    template.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 1,
      DeploymentConfiguration: Match.objectLike({
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      }),
      NetworkConfiguration: {
        AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'ENABLED' }),
      },
    });
    template.hasResourceProperties('AWS::ServiceDiscovery::Service', {
      DnsConfig: Match.objectLike({ DnsRecords: [Match.objectLike({ Type: 'SRV' })] }),
    });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'api',
          HealthCheck: Match.objectLike({ Command: Match.arrayWith(['CMD-SHELL']) }),
        }),
      ]),
    });
  });

  it('limits ingress to VPC-Link-to-API and application-tasks-to-DB', () => {
    const template = render();
    const ingress = template.findResources('AWS::EC2::SecurityGroupIngress');
    const applicationIngress = Object.values(ingress).filter((resource) => {
      const port = resource.Properties?.FromPort;
      return port === 4000 || port === 3306;
    });
    expect(applicationIngress).toHaveLength(3);
    for (const resource of applicationIngress) {
      expect(resource.Properties?.SourceSecurityGroupId).toBeDefined();
      expect(resource.Properties?.CidrIp).toBeUndefined();
    }
    const securityGroups = template.findResources('AWS::EC2::SecurityGroup');
    const worker = Object.values(securityGroups).find(
      (resource) =>
        resource.Properties?.GroupDescription ===
        'Worker and migration tasks have no inbound rules',
    );
    expect(worker).toBeDefined();
    expect(worker?.Properties?.SecurityGroupIngress).toBeUndefined();
  });

  it('proxies the default HTTP API route privately through Cloud Map', () => {
    const template = renderFromCliContext(fullStagingContext);
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      ProtocolType: 'HTTP',
      DisableExecuteApiEndpoint: true,
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
      ConnectionType: 'VPC_LINK',
      IntegrationMethod: 'ANY',
      IntegrationType: 'HTTP_PROXY',
      PayloadFormatVersion: '1.0',
      RequestParameters: { 'overwrite:path': '$request.path' },
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: '$default' });
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      AutoDeploy: true,
      DefaultRouteSettings: { ThrottlingBurstLimit: 100, ThrottlingRateLimit: 50 },
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::DomainName', {
      DomainName: 'api.staging.example.invalid',
      DomainNameConfigurations: [
        Match.objectLike({ EndpointType: 'REGIONAL', SecurityPolicy: 'TLS_1_2' }),
      ],
    });
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'api.staging.example.invalid.',
      Type: 'A',
      AliasTarget: Match.objectLike({ DNSName: Match.anyValue(), HostedZoneId: Match.anyValue() }),
    });
    const stage = Object.values(template.findResources('AWS::ApiGatewayV2::Stage'))[0];
    const accessLogFormat = String(stage?.Properties?.AccessLogSettings?.Format);
    expect(accessLogFormat).toContain('integrationLatency');
    expect(accessLogFormat).not.toMatch(/authorization|cookie|query|string/i);
  });

  it('dispatches encrypted SQS jobs through a least-privilege Pipe to the shared worker task', () => {
    const template = render();
    template.resourceCountIs('AWS::SQS::Queue', 3);
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'oshi-schedule-staging-sync-jobs',
      SqsManagedSseEnabled: true,
      RedrivePolicy: Match.objectLike({
        deadLetterTargetArn: Match.anyValue(),
        maxReceiveCount: 3,
      }),
    });
    template.hasResourceProperties('AWS::Pipes::Pipe', {
      Name: 'oshi-schedule-staging-sync-jobs',
      SourceParameters: { SqsQueueParameters: { BatchSize: 1, MaximumBatchingWindowInSeconds: 0 } },
      TargetParameters: Match.objectLike({
        EcsTaskParameters: Match.objectLike({
          LaunchType: 'FARGATE',
          TaskCount: 1,
          Overrides: Match.objectLike({
            ContainerOverrides: [
              Match.objectLike({
                Name: 'worker',
                Environment: [{ Name: 'SYNC_RUN_ID', Value: '$.body.syncRunId' }],
              }),
            ],
          }),
        }),
      }),
    });
    const taskDefinitions = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
    const worker = taskDefinitions.find((resource) =>
      String(resource.Properties?.Family).endsWith('-worker'),
    );
    const workerEnvironment = worker?.Properties?.ContainerDefinitions?.[0]?.Environment as Array<{
      Name: string;
    }>;
    expect(workerEnvironment.map(({ Name }) => Name)).toContain('SYNC_JOB_QUEUE_URL');
  });

  it('schedules a disabled-by-default hourly Fargate worker with retry and DLQ', () => {
    const template = render();
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'rate(1 hour)',
      State: 'DISABLED',
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: Match.objectLike({
        DeadLetterConfig: Match.objectLike({ Arn: Match.anyValue() }),
        RetryPolicy: { MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 2 },
        EcsParameters: Match.objectLike({ LaunchType: 'FARGATE' }),
      }),
    });
  });

  it('creates an hourly staging-only automatic sleep safety net', () => {
    const template = render('staging');
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'oshi-schedule-staging-auto-sleep',
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
      Timeout: 120,
      MemorySize: 128,
      Environment: {
        Variables: Match.objectLike({
          TARGET_ENVIRONMENT: 'staging',
          EXPECTED_ACCOUNT_ID: '111111111111',
          DEADLINE_PARAMETER_NAME: {
            Ref: Match.stringLikeRegexp('WakeExpiresAtParameter'),
          },
        }),
      },
    });
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/oshi-schedule-staging/runtime/wake-expires-at',
      Type: 'String',
      Value: 'UNSET',
      Tier: 'Standard',
    });
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: 'oshi-schedule-staging-auto-sleep',
      ScheduleExpression: 'rate(1 hour)',
      State: 'ENABLED',
      Target: Match.objectLike({
        RetryPolicy: { MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 2 },
      }),
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'oshi-schedule-staging-auto-sleep-failed',
      MetricName: 'Errors',
      Namespace: 'AWS/Lambda',
      Threshold: 1,
    });
    const autoSleepPolicy = Object.entries(template.findResources('AWS::IAM::Policy')).find(
      ([logicalId]) => logicalId.startsWith('AutoSleepFunctionServiceRoleDefaultPolicy'),
    )?.[1];
    expect(autoSleepPolicy).toBeDefined();
    const policyText = JSON.stringify(autoSleepPolicy);
    for (const action of [
      'ssm:GetParameter',
      'scheduler:GetSchedule',
      'scheduler:UpdateSchedule',
      'iam:PassRole',
      'ecs:DescribeServices',
      'ecs:UpdateService',
      'rds:DescribeDBInstances',
      'rds:StopDBInstance',
    ]) {
      expect(policyText).toContain(action);
    }
    expect(policyText).not.toContain('ecs:*');
    expect(policyText).not.toContain('rds:*');
    expect(policyText).not.toContain('ssm:*');
    expect(policyText).not.toContain('ssm:GetParameters');
    expect(policyText).not.toContain('ssm:GetParameterHistory');
  });

  it('does not create automatic sleep resources for production', () => {
    const template = render('production');
    expect(
      Object.values(template.findResources('AWS::Lambda::Function')).some(
        (resource) => resource.Properties?.FunctionName === 'oshi-schedule-production-auto-sleep',
      ),
    ).toBe(false);
    expect(
      Object.values(template.findResources('AWS::Scheduler::Schedule')).some(
        (resource) => resource.Properties?.Name === 'oshi-schedule-production-auto-sleep',
      ),
    ).toBe(false);
    expect(
      Object.values(template.findResources('AWS::SSM::Parameter')).some(
        (resource) =>
          resource.Properties?.Name === '/oshi-schedule-production/runtime/wake-expires-at',
      ),
    ).toBe(false);
    expect(
      Object.values(template.findResources('AWS::CloudWatch::Alarm')).some(
        (resource) =>
          resource.Properties?.AlarmName === 'oshi-schedule-production-auto-sleep-failed',
      ),
    ).toBe(false);
  });

  it('keeps migration credentials separate from external API secrets', () => {
    const template = render();
    const taskDefinitions = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
    const migration = taskDefinitions.find((resource) =>
      String(resource.Properties?.Family).endsWith('-migration'),
    );
    expect(migration).toBeDefined();
    const secrets = migration?.Properties?.ContainerDefinitions?.[0]?.Secrets as Array<{
      Name: string;
    }>;
    expect(secrets.map(({ Name }) => Name).sort()).toEqual(['DB_PASSWORD', 'DB_USER']);
  });

  it('contains no literal credential values in the CloudFormation template', () => {
    const serialized = JSON.stringify(render().toJSON());
    expect(serialized).not.toMatch(/sb_secret_|AIza[0-9A-Za-z_-]{20,}|v1:[A-Za-z0-9+/]{30,}/);
    expect(serialized).toContain('supabase-service-role-key');
    expect(serialized).toContain('token-encryption-keys');
  });

  it('retains the production database', () => {
    render('production').hasResource('AWS::RDS::DBInstance', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: Match.objectLike({ DeletionProtection: true }),
    });
  });

  it('uses main as the production Amplify source branch', () => {
    render('production').hasResourceProperties('AWS::Amplify::Branch', { BranchName: 'main' });
  });

  it('restricts GitHub OIDC to the configured main branch', () => {
    render().hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: Match.objectLike({
              StringLike: {
                'token.actions.githubusercontent.com:sub':
                  'repo:example-owner/oshi-schedule:ref:refs/heads/main',
              },
            }),
          }),
        ]),
      },
    });
  });

  it('creates operational logs, alarms, notifications, and a budget', () => {
    const template = render();
    template.resourceCountIs('AWS::Logs::LogGroup', 5);
    template.resourceCountIs('AWS::CloudWatch::Alarm', 6);
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.resourceCountIs('AWS::Budgets::Budget', 1);
  });
});
