import { readFileSync } from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import {
  loadConfig,
  type AmplifyConnectionPhase,
  type DeploymentConfig,
  type EnvironmentName,
} from '../lib/config.js';
import { OshiScheduleStack } from '../lib/oshi-schedule-stack.js';

const applicationSecretArns = (environment: EnvironmentName, account = '111111111111') => ({
  supabaseServiceRoleSecretArn: `arn:aws:secretsmanager:ap-northeast-1:${account}:secret:oshi-schedule-${environment}/app/supabase-service-role-key-Ab12Cd`,
  googleClientSecretArn: `arn:aws:secretsmanager:ap-northeast-1:${account}:secret:oshi-schedule-${environment}/app/google-client-secret-Ef34Gh`,
  youtubeApiKeySecretArn: `arn:aws:secretsmanager:ap-northeast-1:${account}:secret:oshi-schedule-${environment}/app/youtube-api-key-Ij56Kl`,
  tokenEncryptionKeysSecretArn: `arn:aws:secretsmanager:ap-northeast-1:${account}:secret:oshi-schedule-${environment}/app/token-encryption-keys-Mn78Op`,
});

const applicationSecretEnvironmentVariables = [
  'GOOGLE_CLIENT_SECRET',
  'SUPABASE_SERVICE_ROLE_KEY',
  'TOKEN_ENCRYPTION_KEYS',
  'YOUTUBE_API_KEY',
] as const;

const repositoryAmplifyBuildSpec = readFileSync(
  new URL('../../amplify.yml', import.meta.url),
  'utf8',
);
const repositoryNpmConfig = readFileSync(new URL('../../.npmrc', import.meta.url), 'utf8');

const extractAmplifyPhaseCommands = (buildSpec: string) => {
  const phases: Record<'preBuild' | 'build', string[]> = { preBuild: [], build: [] };
  let phase: keyof typeof phases | undefined;
  for (const line of buildSpec.split(/\r?\n/)) {
    const phaseMatch = line.match(/^ {8}(preBuild|build):$/);
    if (phaseMatch) {
      phase = phaseMatch[1] as keyof typeof phases;
      continue;
    }
    const commandMatch = line.match(/^ {12}- (.+)$/);
    if (phase && commandMatch) phases[phase].push(commandMatch[1]!);
  }
  return phases;
};

const assertValueFromIamContract = (valueFromArns: unknown[], iamResources: unknown[]): void => {
  for (const valueFromArn of valueFromArns) {
    if (!iamResources.includes(valueFromArn)) {
      throw new Error('TaskDefinition ValueFrom is not allowed by its execution role');
    }
  }
};

const fullStagingContext: Record<string, unknown> = {
  environment: 'staging',
  deployReady: 'true',
  bootstrapOnly: 'false',
  apiDesiredCount: '0',
  syncPipeDesiredState: 'STOPPED',
  applicationActivated: 'false',
  awsAccount: '111111111111',
  awsRegion: 'ap-northeast-1',
  hostedZoneId: 'Z00000000000000000000',
  hostedZoneName: 'example.invalid',
  webDomainName: 'staging.example.invalid',
  apiDomainName: 'api.staging.example.invalid',
  certificateArn:
    'arn:aws:acm:ap-northeast-1:111111111111:certificate/00000000-0000-4000-8000-000000000000',
  ...applicationSecretArns('staging'),
  alertEmail: 'synth-only@example.invalid',
  nextPublicSupabaseUrl: 'https://supabase.example.invalid',
  nextPublicSupabasePublishableKey: 'sb_publishable_synth_only',
  githubOwner: 'example-owner',
  githubRepository: 'oshi-schedule',
  amplifyConnectionPhase: 'manual',
  imageTag: `sha256:${'a'.repeat(64)}`,
};

const configFor = (environmentName: EnvironmentName): DeploymentConfig => ({
  environmentName,
  account: '111111111111',
  region: 'ap-northeast-1',
  deployReady: false,
  bootstrapOnly: false,
  apiDesiredCount: environmentName === 'staging' ? 0 : 1,
  syncPipeDesiredState: environmentName === 'staging' ? 'STOPPED' : 'RUNNING',
  applicationActivated: environmentName === 'production',
  hostedZoneName: 'oshi-schedule.com',
  webDomainName:
    environmentName === 'production' ? 'app.oshi-schedule.com' : 'staging.oshi-schedule.com',
  apiDomainName:
    environmentName === 'production' ? 'api.oshi-schedule.com' : 'api-staging.oshi-schedule.com',
  nextPublicSupabaseUrl:
    environmentName === 'production'
      ? 'https://production-ref.supabase.co'
      : 'https://staging-ref.supabase.co',
  nextPublicSupabasePublishableKey: `sb_publishable_${environmentName}_abc123`,
  googleClientId:
    environmentName === 'production'
      ? '1234567890-prodabc123.apps.googleusercontent.com'
      : undefined,
  ...applicationSecretArns(environmentName),
  monthlyBudgetUsd: environmentName === 'staging' ? 25 : 75,
  githubOwner: 'example-owner',
  githubRepository: 'oshi-schedule',
  amplifyConnectionPhase: environmentName === 'staging' ? 'manual' : 'connected',
  imageTag: `sha256:${'a'.repeat(64)}`,
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

const renderAmplifyPhase = (amplifyConnectionPhase: AmplifyConnectionPhase): Template => {
  const app = new App();
  const stack = new OshiScheduleStack(app, 'test-amplify', {
    env: { account: '111111111111', region: 'ap-northeast-1' },
    config: {
      ...configFor('staging'),
      hostedZoneName: 'example.invalid',
      webDomainName: 'staging.example.invalid',
      amplifyConnectionPhase,
    },
  });
  return Template.fromStack(stack);
};

const resourceDiff = (from: Template, to: Template) => {
  const fromResources = from.toJSON().Resources as Record<string, unknown>;
  const toResources = to.toJSON().Resources as Record<string, unknown>;
  const fromIds = new Set(Object.keys(fromResources));
  const toIds = new Set(Object.keys(toResources));
  return {
    added: [...toIds].filter((id) => !fromIds.has(id)).sort(),
    removed: [...fromIds].filter((id) => !toIds.has(id)).sort(),
    changed: [...fromIds]
      .filter((id) => toIds.has(id))
      .filter((id) => JSON.stringify(fromResources[id]) !== JSON.stringify(toResources[id]))
      .sort(),
  };
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
      'ApplicationActivationParameterName',
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
        'WEB_ORIGIN',
        'NEXT_PUBLIC_API_URL',
        'NEXT_PUBLIC_DEMO_MODE',
        'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
        'NEXT_PUBLIC_SUPABASE_URL',
        '_CUSTOM_IMAGE',
      ].sort(),
    );
    expect(app!.Properties?.EnvironmentVariables).toEqual(
      expect.arrayContaining([{ Name: 'WEB_ORIGIN', Value: 'https://staging.example.invalid' }]),
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

  it('builds the Amplify web app through the existing Turbo workspace dependency graph', () => {
    const template = renderFromCliContext(fullStagingContext);
    const app = Object.values(template.findResources('AWS::Amplify::App'))[0];
    const managedBuildSpec = app?.Properties?.BuildSpec as string;
    const dependencyGraphBuildCommand =
      'pnpm --workspace-root exec turbo build --filter=@oshi-schedule/web';

    for (const buildSpec of [managedBuildSpec, repositoryAmplifyBuildSpec]) {
      expect(buildSpec).toContain(dependencyGraphBuildCommand);
      expect(buildSpec).toContain('test -n "$WEB_ORIGIN"');
      expect(buildSpec).toContain('node scripts/aws/write-amplify-web-runtime-env.mjs');
      expect(buildSpec).not.toContain('pnpm --filter @oshi-schedule/web build');
      expect(buildSpec).not.toContain('pnpm --filter @oshi-schedule/shared build');
    }
    expect(managedBuildSpec).toBe(repositoryAmplifyBuildSpec.trimEnd());
  });

  it('generates the SSR runtime env before building without copying all process variables', () => {
    const phases = extractAmplifyPhaseCommands(repositoryAmplifyBuildSpec);
    const envCommand = 'node scripts/aws/write-amplify-web-runtime-env.mjs';
    const buildCommand = 'pnpm --workspace-root exec turbo build --filter=@oshi-schedule/web';

    expect(phases.build.indexOf(envCommand)).toBeGreaterThan(
      phases.build.indexOf('test -n "$WEB_ORIGIN"'),
    );
    expect(phases.build.indexOf(envCommand)).toBeLessThan(phases.build.indexOf(buildCommand));
    expect(repositoryAmplifyBuildSpec).not.toMatch(/(?:env|printenv).*>>? .*\.env\.production/);
    expect(repositoryAmplifyBuildSpec).not.toContain('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY >>');
  });

  it('uses the Amplify monorepo root without manual cwd manipulation', () => {
    const template = renderFromCliContext(fullStagingContext);
    const app = Object.values(template.findResources('AWS::Amplify::App'))[0];
    const monorepoRoot = (
      app?.Properties?.EnvironmentVariables as Array<{
        Name: string;
        Value: string;
      }>
    ).find(({ Name }) => Name === 'AMPLIFY_MONOREPO_APP_ROOT');
    const phases = extractAmplifyPhaseCommands(repositoryAmplifyBuildSpec);

    expect(repositoryAmplifyBuildSpec).toContain('  - appRoot: apps/web');
    expect(repositoryAmplifyBuildSpec).toContain('      buildPath: /');
    expect(monorepoRoot).toEqual({ Name: 'AMPLIFY_MONOREPO_APP_ROOT', Value: 'apps/web' });
    expect(repositoryNpmConfig.trim()).toBe('node-linker=hoisted');
    expect([...phases.preBuild, ...phases.build]).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^(?:cd\b|.*CODEBUILD_SRC_DIR)/)]),
    );
  });

  it('synthesizes the exact Amplify resources for every connection phase', () => {
    const expectedCounts = {
      manual: { branch: 1, domain: 1 },
      'domain-detached': { branch: 1, domain: 0 },
      detached: { branch: 0, domain: 0 },
      connected: { branch: 1, domain: 1 },
    } as const;

    for (const [phase, expected] of Object.entries(expectedCounts)) {
      const template = renderAmplifyPhase(phase as AmplifyConnectionPhase);
      template.resourceCountIs('AWS::Amplify::App', 1);
      template.resourceCountIs('AWS::Amplify::Branch', expected.branch);
      template.resourceCountIs('AWS::Amplify::Domain', expected.domain);
      const app = Object.values(template.findResources('AWS::Amplify::App'))[0];
      expect(app?.Properties).not.toHaveProperty('Repository');
    }

    renderAmplifyPhase('manual').hasResource('AWS::Amplify::Domain', {
      DependsOn: ['AmplifyBranch'],
    });
    renderAmplifyPhase('connected').hasResource('AWS::Amplify::Domain', {
      DependsOn: ['AmplifyBranch'],
    });
  });

  it('fixes the allowed resource diff for the staged Amplify migration', () => {
    const manual = renderAmplifyPhase('manual');
    const domainDetached = renderAmplifyPhase('domain-detached');
    const detached = renderAmplifyPhase('detached');
    const connected = renderAmplifyPhase('connected');

    expect(resourceDiff(manual, domainDetached)).toEqual({
      added: [],
      removed: ['AmplifyDomain'],
      changed: [],
    });
    expect(resourceDiff(domainDetached, detached)).toEqual({
      added: [],
      removed: ['AmplifyBranch'],
      changed: [],
    });
    expect(resourceDiff(detached, connected)).toEqual({
      added: ['AmplifyBranch', 'AmplifyDomain'],
      removed: [],
      changed: [],
    });
    expect(Object.keys(manual.findResources('AWS::Amplify::App'))).toEqual(
      Object.keys(connected.findResources('AWS::Amplify::App')),
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
      'ApplicationActivationParameterName',
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

  it('synthesizes the migration-safe staging Phase 1 state', () => {
    const template = render();
    template.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 0,
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
    template.hasResourceProperties('AWS::Pipes::Pipe', { DesiredState: 'STOPPED' });
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/oshi-schedule-staging/runtime/application-activated',
      Type: 'String',
      Value: 'false',
      Tier: 'Standard',
    });
  });

  it('pins API, Worker, and Migration task definitions to the same image digest', () => {
    const template = renderFromCliContext(fullStagingContext);
    const taskDefinitions = Object.values(template.findResources('AWS::ECS::TaskDefinition'));

    expect(taskDefinitions).toHaveLength(3);
    for (const taskDefinition of taskDefinitions) {
      expect(JSON.stringify(taskDefinition.Properties?.ContainerDefinitions?.[0]?.Image)).toContain(
        `@sha256:${'a'.repeat(64)}`,
      );
    }
  });

  it('synthesizes the staging Phase 2 activation state', () => {
    const template = renderFromCliContext({
      ...fullStagingContext,
      apiDesiredCount: '1',
      syncPipeDesiredState: 'RUNNING',
      applicationActivated: 'true',
    });
    template.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 1 });
    template.hasResourceProperties('AWS::Pipes::Pipe', { DesiredState: 'RUNNING' });
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/oshi-schedule-staging/runtime/application-activated',
      Value: 'true',
    });
  });

  it('uses the active production defaults', () => {
    const template = render('production');
    template.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 1 });
    template.hasResourceProperties('AWS::Pipes::Pipe', { DesiredState: 'RUNNING' });
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/oshi-schedule-production/runtime/application-activated',
      Value: 'true',
    });
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/oshi-schedule-production/runtime/supabase-url',
      Value: 'https://production-ref.supabase.co',
    });
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/oshi-schedule-production/runtime/google-client-id',
      Value: '1234567890-prodabc123.apps.googleusercontent.com',
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
      DesiredState: 'STOPPED',
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

  it('uses the configured complete ARNs for API and Worker application secrets in both phases', () => {
    const phase1 = renderFromCliContext(fullStagingContext);
    const phase2 = renderFromCliContext({
      ...fullStagingContext,
      apiDesiredCount: '1',
      syncPipeDesiredState: 'RUNNING',
      applicationActivated: 'true',
    });
    const expectedArns = applicationSecretArns('staging');
    const expectedByEnvironmentVariable = {
      SUPABASE_SERVICE_ROLE_KEY: expectedArns.supabaseServiceRoleSecretArn,
      GOOGLE_CLIENT_SECRET: expectedArns.googleClientSecretArn,
      YOUTUBE_API_KEY: expectedArns.youtubeApiKeySecretArn,
      TOKEN_ENCRYPTION_KEYS: expectedArns.tokenEncryptionKeysSecretArn,
    };

    const applicationSecretsByFamily = (template: Template, familySuffix: string) => {
      const taskDefinition = Object.values(template.findResources('AWS::ECS::TaskDefinition')).find(
        (resource) => String(resource.Properties?.Family).endsWith(familySuffix),
      );
      const secrets = taskDefinition?.Properties?.ContainerDefinitions?.[0]?.Secrets as Array<{
        Name: string;
        ValueFrom: unknown;
      }>;
      return Object.fromEntries(
        secrets
          .filter(({ Name }) => applicationSecretEnvironmentVariables.includes(Name as never))
          .map(({ Name, ValueFrom }) => [Name, ValueFrom]),
      );
    };

    for (const familySuffix of ['-api', '-worker']) {
      const phase1Secrets = applicationSecretsByFamily(phase1, familySuffix);
      const phase2Secrets = applicationSecretsByFamily(phase2, familySuffix);
      expect(phase1Secrets).toEqual(expectedByEnvironmentVariable);
      expect(phase2Secrets).toEqual(expectedByEnvironmentVariable);
      expect(phase2Secrets).toEqual(phase1Secrets);
      for (const valueFrom of Object.values(phase1Secrets)) {
        expect(valueFrom).toMatch(/-[A-Za-z0-9]{6}$/);
      }
    }

    expect(applicationSecretsByFamily(phase1, '-migration')).toEqual({});
  });

  it('keeps task-definition ValueFrom and execution-role GetSecretValue resources identical', () => {
    const template = renderFromCliContext(fullStagingContext);
    const taskDefinitions = template.findResources('AWS::ECS::TaskDefinition');
    const roles = template.findResources('AWS::IAM::Role');
    const policies = template.findResources('AWS::IAM::Policy');

    for (const [familySuffix, logicalPrefix] of [
      ['-api', 'ApiTaskDefinition'],
      ['-worker', 'WorkerTaskDefinition'],
    ] as const) {
      const taskDefinition = Object.values(taskDefinitions).find((resource) =>
        String(resource.Properties?.Family).endsWith(familySuffix),
      );
      const valueFromArns = (
        taskDefinition?.Properties?.ContainerDefinitions?.[0]?.Secrets as Array<{
          Name: string;
          ValueFrom: unknown;
        }>
      )
        .filter(({ Name }) => applicationSecretEnvironmentVariables.includes(Name as never))
        .map(({ ValueFrom }) => ValueFrom);
      const executionRoleLogicalId = Object.keys(roles).find((logicalId) =>
        logicalId.startsWith(`${logicalPrefix}ExecutionRole`),
      );
      expect(executionRoleLogicalId).toBeDefined();
      const executionPolicies = Object.values(policies).filter((policy) =>
        (policy.Properties?.Roles as Array<{ Ref?: string }> | undefined)?.some(
          (role) => role.Ref === executionRoleLogicalId,
        ),
      );
      const getSecretValueResources = executionPolicies.flatMap((policy) =>
        (
          policy.Properties?.PolicyDocument?.Statement as Array<{
            Action: string | string[];
            Resource: unknown | unknown[];
          }>
        ).flatMap((statement) => {
          const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
          if (!actions.includes('secretsmanager:GetSecretValue')) return [];
          return Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
        }),
      );

      expect(() =>
        assertValueFromIamContract(valueFromArns, getSecretValueResources),
      ).not.toThrow();
      expect(
        getSecretValueResources
          .filter((resource): resource is string => typeof resource === 'string')
          .sort(),
      ).toEqual([...valueFromArns].sort());
      const applicationSecretStatements = executionPolicies.flatMap((policy) =>
        (
          policy.Properties?.PolicyDocument?.Statement as Array<{
            Action: string | string[];
            Resource: unknown;
          }>
        ).filter((statement) => {
          const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
          return (
            typeof statement.Resource === 'string' &&
            actions.includes('secretsmanager:GetSecretValue')
          );
        }),
      );
      expect(applicationSecretStatements).toHaveLength(4);
      for (const statement of applicationSecretStatements) {
        expect(statement.Action).toBe('secretsmanager:GetSecretValue');
      }
      expect(getSecretValueResources).not.toContain('*');
      expect(JSON.stringify(executionPolicies)).not.toContain('secretsmanager:*');
      expect(JSON.stringify(executionPolicies)).not.toContain('kms:Decrypt');
    }

    for (const logicalId of Object.keys(roles).filter((logicalId) =>
      /(?:Api|Worker)TaskDefinitionTaskRole/.test(logicalId),
    )) {
      const taskRolePolicies = Object.values(policies).filter((policy) =>
        (policy.Properties?.Roles as Array<{ Ref?: string }> | undefined)?.some(
          (role) => role.Ref === logicalId,
        ),
      );
      expect(JSON.stringify(taskRolePolicies)).not.toContain('secretsmanager:GetSecretValue');
    }
  });

  it('rejects mismatched task-definition ValueFrom and execution-role resources', () => {
    const completeArn = applicationSecretArns('staging').googleClientSecretArn;
    const partialArn = completeArn.replace(/-[A-Za-z0-9]{6}$/, '');
    const unrelatedArn = applicationSecretArns('staging').youtubeApiKeySecretArn;

    expect(() => assertValueFromIamContract([partialArn], [completeArn])).toThrow(
      /ValueFrom is not allowed/,
    );
    expect(() => assertValueFromIamContract([completeArn], [unrelatedArn])).toThrow(
      /ValueFrom is not allowed/,
    );
  });

  it('injects allowed emails only into the API from the secure SSM parameter', () => {
    const template = render();
    const rendered = template.toJSON();
    const taskDefinitions = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
    const findContainer = (familySuffix: string) =>
      taskDefinitions.find((resource) => String(resource.Properties?.Family).endsWith(familySuffix))
        ?.Properties?.ContainerDefinitions?.[0];
    const api = findContainer('-api');
    const worker = findContainer('-worker');
    const migration = findContainer('-migration');

    expect(api?.Secrets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Name: 'ALLOWED_EMAILS',
          ValueFrom: {
            'Fn::Join': [
              '',
              [
                'arn:',
                { Ref: 'AWS::Partition' },
                ':ssm:ap-northeast-1:111111111111:parameter/oshi-schedule-staging/runtime/allowed-emails',
              ],
            ],
          },
        }),
      ]),
    );
    expect((api?.Environment as Array<{ Name: string }>).map(({ Name }) => Name)).not.toContain(
      'ALLOWED_EMAILS',
    );
    for (const container of [worker, migration]) {
      expect((container?.Secrets as Array<{ Name: string }>).map(({ Name }) => Name)).not.toContain(
        'ALLOWED_EMAILS',
      );
      expect(
        (container?.Environment as Array<{ Name: string }>).map(({ Name }) => Name),
      ).not.toContain('ALLOWED_EMAILS');
    }

    expect(JSON.stringify(rendered.Parameters ?? {})).not.toContain('allowed-emails');
    expect(JSON.stringify(rendered)).not.toContain('{{resolve:ssm-secure:');
  });

  it('grants the API execution role scoped read access to allowed emails', () => {
    const template = render();
    const policies = template.findResources('AWS::IAM::Policy');
    const allowedEmailPolicies = Object.entries(policies).filter(([, resource]) =>
      JSON.stringify(resource).includes('parameter/oshi-schedule-staging/runtime/allowed-emails'),
    );

    expect(allowedEmailPolicies).toHaveLength(1);
    expect(allowedEmailPolicies[0]?.[0]).toMatch(/^ApiTaskDefinitionExecutionRole/);
    const policyText = JSON.stringify(allowedEmailPolicies[0]?.[1]);
    expect(policyText).toContain('ssm:GetParameters');
    expect(policyText).not.toContain('"ssm:*"');
    expect(policyText).not.toContain('"kms:*"');
    expect(policyText).not.toContain('kms:Decrypt');
    const statements = allowedEmailPolicies[0]?.[1].Properties?.PolicyDocument?.Statement as Array<{
      Action: string | string[];
      Resource: unknown;
    }>;
    const allowedEmailStatement = statements.find((statement) =>
      JSON.stringify(statement.Resource).includes(
        'parameter/oshi-schedule-staging/runtime/allowed-emails',
      ),
    );
    expect(allowedEmailStatement).toBeDefined();
    expect(allowedEmailStatement?.Action).toBe('ssm:GetParameters');
    expect(allowedEmailStatement?.Resource).not.toBe('*');
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
