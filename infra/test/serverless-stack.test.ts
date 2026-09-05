import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DeploymentConfig } from '../lib/config.js';
import {
  createLambdaBundling,
  lambdaBundling,
  lambdaSourceAliases,
  ServerlessOshiScheduleStack,
} from '../lib/serverless-stack.js';

const account = '111111111111';
const secret = (suffix: string) =>
  `arn:aws:secretsmanager:ap-northeast-1:${account}:secret:oshi-schedule-production/${suffix}-Ab12Cd`;

const config: DeploymentConfig = {
  environmentName: 'production',
  account,
  region: 'ap-northeast-1',
  deployReady: false,
  bootstrapOnly: false,
  runtimeArchitecture: 'serverless',
  serverlessStagingMode: 'cutover',
  apiDesiredCount: 0,
  syncPipeDesiredState: 'STOPPED',
  applicationActivated: false,
  hostedZoneId: 'Z00000000000000000000',
  hostedZoneName: 'oshi-schedule.com',
  webDomainName: 'oshi-schedule.com',
  apiDomainName: 'api.oshi-schedule.com',
  certificateArn:
    `arn:aws:acm:ap-northeast-1:${account}:certificate/00000000-0000-4000-8000-000000000000`,
  alertEmail: 'alerts@oshi-schedule.com',
  nextPublicSupabaseUrl: 'https://production-ref.supabase.co',
  nextPublicSupabasePublishableKey: 'sb_publishable_production_test',
  googleClientId: '1234567890-production.apps.googleusercontent.com',
  supabaseServiceRoleSecretArn: secret('app/supabase-service-role-key'),
  googleClientSecretArn: secret('app/google-client-secret'),
  youtubeApiKeySecretArn: secret('app/youtube-api-key'),
  tokenEncryptionKeysSecretArn: secret('app/token-encryption-keys'),
  databaseUrlSecretArn: secret('app/database-runtime-url'),
  databaseMigrationUrlSecretArn: secret('app/database-migration-url'),
  backupRetentionDays: 7,
  monthlyBudgetUsd: 20,
  githubOwner: 'musenmai-08',
  githubRepository: 'oshi-schedule',
  amplifyConnectionPhase: 'connected',
  imageTag: 'bootstrap-retained-only',
  apiCpu: 256,
  apiMemoryMiB: 512,
  workerCpu: 256,
  workerMemoryMiB: 512,
  rdsInstanceType: 'unused',
  rdsAllocatedStorageGiB: 0,
  rdsBackupRetentionDays: 0,
  rdsMultiAz: false,
  rdsDeletionProtection: false,
  workerScheduleEnabled: false,
};

const render = () => {
  const app = new App();
  return Template.fromStack(
    new ServerlessOshiScheduleStack(app, 'serverless-production', {
      env: { account, region: 'ap-northeast-1' },
      config,
    }),
  );
};

const renderStagingPreview = () => {
  const app = new App();
  return Template.fromStack(
    new ServerlessOshiScheduleStack(app, 'serverless-staging-preview', {
      env: { account, region: 'ap-northeast-1' },
      config: {
        ...config,
        environmentName: 'staging',
        serverlessStagingMode: 'preview',
        amplifyConnectionPhase: 'manual',
      },
    }),
  );
};

describe('ServerlessOshiScheduleStack', () => {
  it('supplies Node createRequire to ESM Lambda bundles with CommonJS dependencies', () => {
    expect(lambdaBundling.format).toBeDefined();
    expect(lambdaBundling.banner).toContain('createRequire');
    expect(lambdaBundling.banner).toContain('const require');
  });

  it('bundles the Worker against API source even when package exports target dist', async () => {
    const repositoryRoot = resolve(import.meta.dirname, '../..');
    const aliases = lambdaSourceAliases(repositoryRoot);
    const packageJson = await readFile(resolve(repositoryRoot, 'apps/api/package.json'), 'utf8');
    expect(packageJson).toContain('"./dist/runtime.js"');
    expect(packageJson).toContain('"./dist/infrastructure/lambda/runtime-env.js"');
    expect(aliases).toEqual({
      '@oshi-schedule/api/runtime': resolve(repositoryRoot, 'apps/api/src/runtime.ts'),
      '@oshi-schedule/api/lambda-env': resolve(
        repositoryRoot,
        'apps/api/src/infrastructure/lambda/runtime-env.ts',
      ),
    });
    expect(createLambdaBundling(repositoryRoot).esbuildArgs).toMatchObject({
      '--alias:@oshi-schedule/api/runtime': aliases['@oshi-schedule/api/runtime'],
      '--alias:@oshi-schedule/api/lambda-env': aliases['@oshi-schedule/api/lambda-env'],
    });

    const bundle = await build({
      absWorkingDir: repositoryRoot,
      entryPoints: ['apps/worker/src/lambda.ts'],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      alias: aliases,
      external: ['@prisma/client', '.prisma/client'],
      metafile: true,
      write: false,
    });
    const inputs = Object.keys(bundle.metafile.inputs).map((input) => resolve(repositoryRoot, input));
    expect(inputs).toContain(resolve(repositoryRoot, 'apps/api/src/runtime.ts'));
    expect(inputs).toContain(
      resolve(repositoryRoot, 'apps/api/src/infrastructure/lambda/runtime-env.ts'),
    );
    expect(inputs.some((input) => input.includes('/apps/api/dist/'))).toBe(false);
    expect(bundle.outputFiles[0]?.text).toContain('createWorkerContainer');
  }, 15_000);

  it('eliminates the legacy network, database, ECS and Pipe resources', () => {
    const template = render();
    for (const type of [
      'AWS::EC2::VPC',
      'AWS::EC2::NatGateway',
      'AWS::RDS::DBInstance',
      'AWS::ECS::Service',
      'AWS::ECS::TaskDefinition',
      'AWS::ApiGatewayV2::VpcLink',
      'AWS::ServiceDiscovery::PrivateDnsNamespace',
      'AWS::Pipes::Pipe',
    ])
      template.resourceCountIs(type, 0);
    template.resourceCountIs('AWS::Lambda::Function', 2);
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    template.resourceCountIs('AWS::Scheduler::Schedule', 1);
  }, 15_000);

  it('keeps account-wide Lambda concurrency unreserved and bounds worker delivery through SQS', () => {
    const template = render();
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'oshi-schedule-production-api',
      Timeout: 29,
      Environment: { Variables: { RATE_LIMIT_TABLE_NAME: Match.anyValue() } },
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'oshi-schedule-production-worker',
      Timeout: 840,
    });
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'oshi-schedule-production-sync-jobs',
      VisibilityTimeout: 5400,
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
      ScalingConfig: { MaximumConcurrency: 2 },
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      Target: Match.objectLike({
        Arn: { 'Fn::GetAtt': [Match.stringLikeRegexp('SyncJobQueue'), 'Arn'] },
        Input: '{"kind":"scheduled"}',
      }),
    });
    const functions = Object.values(
      render().toJSON().Resources as Record<string, { Type?: string; Properties?: Record<string, unknown> }>,
    ).filter((resource) => resource.Type === 'AWS::Lambda::Function');
    for (const fn of functions) expect(fn.Properties?.ReservedConcurrentExecutions).toBeUndefined();
  }, 15_000);

  it('stores seven daily backup generations in a private encrypted S3 bucket', () => {
    const template = render();
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
      LifecycleConfiguration: {
        Rules: Match.arrayWith([Match.objectLike({ ExpirationInDays: 7, Status: 'Enabled' })]),
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('limits the GitHub backup role to app dump upload and verification, never deletion', () => {
    const policies = Object.values(render().findResources('AWS::IAM::Policy')) as Array<{
      Properties?: unknown;
    }>;
    const backupPolicy = policies
      .map((policy) => JSON.stringify(policy.Properties))
      .find((policy) => policy.includes('database/*'));
    expect(backupPolicy).toBeDefined();
    expect(backupPolicy).toContain('s3:PutObject');
    expect(backupPolicy).toContain('s3:GetObject');
    expect(backupPolicy).not.toContain('s3:DeleteObject');
  });

  it('destroys an empty staging-preview backup bucket on rollback but retains production backups', () => {
    const productionBucket = Object.values(render().findResources('AWS::S3::Bucket'))[0] as {
      DeletionPolicy?: string;
    };
    const previewBucket = Object.values(
      renderStagingPreview().findResources('AWS::S3::Bucket'),
    )[0] as { DeletionPolicy?: string };
    expect(productionBucket?.DeletionPolicy).toBe('Retain');
    expect(previewBucket?.DeletionPolicy).toBe('Delete');
  }, 15_000);

  it('uses Lambda-native runtime limits and keeps the legacy image only as a retained repository', () => {
    const template = render();
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'oshi-schedule-production',
      ImageTagMutability: 'IMMUTABLE',
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['x86_64'],
    });
  }, 15_000);

  it('does not grant the Worker the API-only Supabase service-role secret', () => {
    const resources = render().toJSON().Resources as Record<string, { Type?: string; Properties?: unknown }>;
    const workerPolicy = Object.entries(resources)
      .filter(([logicalId, resource]) =>
        logicalId.includes('WorkerFunctionServiceRole') && resource.Type === 'AWS::IAM::Policy',
      )
      .map(([, resource]) => JSON.stringify(resource.Properties))
      .join('\n');
    expect(workerPolicy).toBeDefined();
    expect(workerPolicy).not.toContain('supabase-service-role-key');
  }, 15_000);

  it('keeps the SQS dispatch URL API-only while the Worker consumes deliveries', () => {
    const functions = Object.values(
      render().toJSON().Resources as Record<string, { Type?: string; Properties?: Record<string, unknown> }>,
    ).filter((resource) => resource.Type === 'AWS::Lambda::Function');
    const environmentNames = (functionName: string) => {
      const fn = functions.find(
        (resource) => resource.Properties?.FunctionName === functionName,
      );
      const variables = fn?.Properties?.Environment as
        | { Variables?: Record<string, unknown> }
        | undefined;
      return Object.keys(variables?.Variables ?? {});
    };

    expect(environmentNames('oshi-schedule-production-api')).toContain('SYNC_JOB_QUEUE_URL');
    expect(environmentNames('oshi-schedule-production-worker')).not.toContain('SYNC_JOB_QUEUE_URL');
  }, 15_000);

  it('keeps the existing staging domain, Amplify app, and ECR rollback assets isolated', () => {
    const template = renderStagingPreview();
    template.resourceCountIs('AWS::Amplify::App', 0);
    template.resourceCountIs('AWS::ECR::Repository', 0);
    template.resourceCountIs('AWS::ApiGatewayV2::DomainName', 0);
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'oshi-schedule-staging-serverless-api',
    });
  }, 15_000);
});
