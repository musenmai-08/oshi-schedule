import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import type { DeploymentConfig, EnvironmentName } from '../lib/config.js';
import { OshiScheduleStack } from '../lib/oshi-schedule-stack.js';

const configFor = (environmentName: EnvironmentName): DeploymentConfig => ({
  environmentName,
  account: '111111111111',
  region: 'ap-northeast-1',
  deployReady: false,
  bootstrapOnly: false,
  monthlyBudgetUsd: 75,
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

describe('OshiScheduleStack', () => {
  it('supports an ECR-first bootstrap without creating billable compute or database resources', () => {
    const app = new App();
    const config = { ...configFor('staging'), bootstrapOnly: true };
    const template = Template.fromStack(
      new OshiScheduleStack(app, 'test-bootstrap', {
        env: { account: '111111111111', region: 'ap-northeast-1' },
        config,
      }),
    );
    template.resourceCountIs('AWS::ECR::Repository', 1);
    template.resourceCountIs('AWS::ECS::Service', 0);
    template.resourceCountIs('AWS::RDS::DBInstance', 0);
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
      EngineVersion: '8.4.6',
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
