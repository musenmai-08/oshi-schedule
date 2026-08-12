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
  monthlyBudgetUsd: environmentName === 'staging' ? 40 : 75,
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
    template.resourceCountIs('AWS::Amplify::App', 0);
    template.resourceCountIs('AWS::Scheduler::Schedule', 0);
    template.resourceCountIs('AWS::Budgets::Budget', 0);
    template.resourceCountIs('AWS::SecretsManager::Secret', 0);
    template.resourceCountIs('AWS::SSM::Parameter', 0);
    template.hasOutput('EnvironmentName', { Value: 'staging' });
  });

  it('synthesizes full staging resources from CLI string context', () => {
    const template = renderFromCliContext(fullStagingContext);
    template.resourceCountIs('AWS::ECS::Service', 1);
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    template.resourceCountIs('AWS::Amplify::App', 1);
    template.resourceCountIs('AWS::Scheduler::Schedule', 1);
    template.resourceCountIs('AWS::Budgets::Budget', 1);
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({ BudgetLimit: { Amount: 40, Unit: 'USD' } }),
    });
    for (const output of [
      'EnvironmentName',
      'EcsClusterName',
      'ApiServiceName',
      'RdsInstanceIdentifier',
      'WorkerScheduleName',
      'LoadBalancerArn',
      'LoadBalancerDnsName',
      'ApiUrl',
      'WebUrl',
      'AmplifyAppId',
    ]) {
      template.hasOutput(output, {});
    }
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
      'LoadBalancerArn',
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

  it('runs one circuit-broken API service with public IP and IP targets', () => {
    const template = render();
    template.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 1,
      DeploymentConfiguration: Match.objectLike({ DeploymentCircuitBreaker: { Enable: true, Rollback: true } }),
      NetworkConfiguration: {
        AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'ENABLED' }),
      },
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      TargetType: 'ip',
      HealthCheckPath: '/health',
    });
  });

  it('limits ingress to ALB-to-API and application-tasks-to-DB', () => {
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
      (resource) => resource.Properties?.GroupDescription === 'Worker and migration tasks have no inbound rules',
    );
    expect(worker).toBeDefined();
    expect(worker?.Properties?.SecurityGroupIngress).toBeUndefined();
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

  it('keeps migration credentials separate from external API secrets', () => {
    const template = render();
    const taskDefinitions = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
    const migration = taskDefinitions.find((resource) =>
      String(resource.Properties?.Family).endsWith('-migration'),
    );
    expect(migration).toBeDefined();
    const secrets = migration?.Properties?.ContainerDefinitions?.[0]?.Secrets as Array<{ Name: string }>;
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
    template.resourceCountIs('AWS::Logs::LogGroup', 3);
    template.resourceCountIs('AWS::CloudWatch::Alarm', 4);
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.resourceCountIs('AWS::Budgets::Budget', 1);
  });
});
