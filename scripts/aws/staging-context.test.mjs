import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import {
  buildPhaseContext,
  commonContextFingerprint,
  externalContextKeys,
  formatContextSummary,
  loadCommonContext,
  loadRepositoryContext,
  phaseContextKeys,
  repositoryContextKeys,
  toCdkContextArgs,
  validateRepositoryContext,
} from './staging-context.mjs';

const repositoryContext = {
  environment: 'staging',
  deployReady: true,
  bootstrapOnly: false,
  awsAccount: '123456789012',
  awsRegion: 'ap-northeast-1',
  hostedZoneId: 'Z0123456789ABCDEF',
  hostedZoneName: 'example.com',
  webDomainName: 'staging.example.com',
  apiDomainName: 'api-staging.example.com',
  certificateArn:
    'arn:aws:acm:ap-northeast-1:123456789012:certificate/12345678-1234-1234-1234-123456789abc',
  supabaseServiceRoleSecretArn:
    'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:oshi-schedule-staging/app/supabase-service-role-key-Ab12Cd',
  googleClientSecretArn:
    'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:oshi-schedule-staging/app/google-client-secret-Ef34Gh',
  youtubeApiKeySecretArn:
    'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:oshi-schedule-staging/app/youtube-api-key-Ij56Kl',
  tokenEncryptionKeysSecretArn:
    'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:oshi-schedule-staging/app/token-encryption-keys-Mn78Op',
  monthlyBudgetUsd: 25,
  githubOwner: 'example-owner',
  githubRepository: 'example-repository',
  amplifyConnectionPhase: 'manual',
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
};

const externalContext = {
  STAGING_ALERT_EMAIL: 'alerts@example.com',
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${'a'.repeat(32)}`,
};

const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const writeFixture = async (config = repositoryContext, envSource = '') => {
  const directory = await mkdtemp(path.join(tmpdir(), 'oshi-staging-context-'));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, 'staging-deploy.json');
  const envPath = path.join(directory, '.env');
  await writeFile(configPath, `${JSON.stringify(config)}\n`);
  await writeFile(envPath, envSource);
  return { configPath, envPath };
};

describe('staging common deploy context', () => {
  it('pins the approved runtime image digest in the repository source of truth', async () => {
    const context = await loadRepositoryContext();

    assert.equal(
      context.imageTag,
      'sha256:781ed5a511661695bcfa43ae0930055da195a8d396ca2cb5d3a01a96594ccb6e',
    );
  });

  it('loads repository and external inputs without changing their ownership', async () => {
    const paths = await writeFixture();
    const common = await loadCommonContext({ ...paths, env: externalContext });

    assert.deepEqual(
      Object.keys(common).sort(),
      [...repositoryContextKeys, ...externalContextKeys].sort(),
    );
    assert.equal(common.imageTag, repositoryContext.imageTag);
    assert.equal(common.alertEmail, externalContext.STAGING_ALERT_EMAIL);
  });

  it('uses ignored env input and the documented ALLOWED_EMAILS fallback', async () => {
    const paths = await writeFixture(
      repositoryContext,
      [
        'ALLOWED_EMAILS=first@example.com,second@example.com',
        `NEXT_PUBLIC_SUPABASE_URL=${externalContext.NEXT_PUBLIC_SUPABASE_URL}`,
        `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${externalContext.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY}`,
      ].join('\n'),
    );
    const common = await loadCommonContext({ ...paths, env: {} });

    assert.equal(common.alertEmail, 'first@example.com');
  });

  it('keeps every common value identical between Phase 1 and Phase 2', () => {
    const common = { ...repositoryContext, alertEmail: 'alerts@example.com', marker: 'same' };
    const phase1 = buildPhaseContext(common, 'phase1');
    const phase2 = buildPhaseContext(common, 'phase2');
    const changedKeys = Object.keys(phase1).filter((key) => phase1[key] !== phase2[key]);

    assert.deepEqual(changedKeys.sort(), [...phaseContextKeys].sort());
    assert.equal(phase1.apiDesiredCount, 0);
    assert.equal(phase1.syncPipeDesiredState, 'STOPPED');
    assert.equal(phase1.applicationActivated, false);
    assert.equal(phase2.apiDesiredCount, 1);
    assert.equal(phase2.syncPipeDesiredState, 'RUNNING');
    assert.equal(phase2.applicationActivated, true);
    assert.equal(commonContextFingerprint(phase1), commonContextFingerprint(phase2));
  });

  it('renders every managed CDK context exactly once', () => {
    const complete = buildPhaseContext(
      {
        ...repositoryContext,
        alertEmail: 'alerts@example.com',
        nextPublicSupabaseUrl: externalContext.NEXT_PUBLIC_SUPABASE_URL,
        nextPublicSupabasePublishableKey: externalContext.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      },
      'phase1',
    );
    const arguments_ = toCdkContextArgs(complete);
    const renderedKeys = arguments_
      .filter((argument, index) => index % 2 === 1)
      .map((argument) => argument.slice(0, argument.indexOf('=')));

    assert.deepEqual(renderedKeys, [
      ...repositoryContextKeys,
      ...externalContextKeys,
      ...phaseContextKeys,
    ]);
  });

  it('masks the notification email and publishable key in dry-run output', () => {
    const common = {
      ...repositoryContext,
      alertEmail: 'private-alert@example.com',
      nextPublicSupabaseUrl: externalContext.NEXT_PUBLIC_SUPABASE_URL,
      nextPublicSupabasePublishableKey: externalContext.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    };
    const summary = formatContextSummary(common, 'phase1');

    assert.doesNotMatch(summary, /private-alert@example\.com/);
    assert.doesNotMatch(summary, new RegExp(externalContext.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY));
    assert.match(summary, /alertEmail=<masked>/);
    assert.match(summary, /nextPublicSupabasePublishableKey=<masked>/);
  });

  for (const [name, patch, expected] of [
    ['account', { awsAccount: '123' }, /awsAccount/],
    ['region', { awsRegion: 'tokyo' }, /awsRegion/],
    ['certificate', { certificateArn: 'not-an-arn' }, /certificateArn/],
    ['domain', { apiDomainName: 'localhost' }, /apiDomainName/],
    ['digest', { imageTag: 'latest' }, /imageTag/],
    ['budget', { monthlyBudgetUsd: 0 }, /monthlyBudgetUsd/],
    ['worker schedule', { workerScheduleEnabled: true }, /workerScheduleEnabled/],
    ['Amplify connection phase', { amplifyConnectionPhase: 'invalid' }, /amplifyConnectionPhase/],
    [
      'partial secret ARN',
      {
        googleClientSecretArn:
          'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:oshi-schedule-staging/app/google-client-secret',
      },
      /googleClientSecretArn/,
    ],
    [
      'mismatched secret name',
      {
        youtubeApiKeySecretArn:
          'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:oshi-schedule-staging/app/google-client-secret-Ab12Cd',
      },
      /youtubeApiKeySecretArn/,
    ],
    [
      'mismatched secret account',
      {
        tokenEncryptionKeysSecretArn:
          'arn:aws:secretsmanager:ap-northeast-1:999999999999:secret:oshi-schedule-staging/app/token-encryption-keys-Ab12Cd',
      },
      /tokenEncryptionKeysSecretArn/,
    ],
    [
      'mismatched secret region',
      {
        supabaseServiceRoleSecretArn:
          'arn:aws:secretsmanager:us-east-1:123456789012:secret:oshi-schedule-staging/app/supabase-service-role-key-Ab12Cd',
      },
      /supabaseServiceRoleSecretArn/,
    ],
    [
      'secret suffix',
      {
        googleClientSecretArn:
          'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:oshi-schedule-staging/app/google-client-secret-short',
      },
      /googleClientSecretArn/,
    ],
  ]) {
    it(`rejects malformed ${name} configuration`, () => {
      assert.throws(() => validateRepositoryContext({ ...repositoryContext, ...patch }), expected);
    });
  }

  it('rejects missing and unexpected repository keys', () => {
    const missing = { ...repositoryContext };
    delete missing.imageTag;
    assert.throws(() => validateRepositoryContext(missing), /missing repository keys: imageTag/);
    assert.throws(
      () => validateRepositoryContext({ ...repositoryContext, secret: 'must-not-exist' }),
      /unexpected repository keys: secret/,
    );
  });

  it('rejects manual CDK context overrides before reading external inputs', () => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(import.meta.dirname, 'staging-rollout.mjs'),
        'phase1',
        'synth',
        '-c',
        'imageTag=bad',
      ],
      { encoding: 'utf8', env: {} },
    );

    assert.equal(result.status, 2);
    assert.match(result.stderr, /owned by the formal preset/);
    assert.doesNotMatch(result.stderr, /imageTag=bad/);
  });

  it('defaults a phase preset invocation to synth', () => {
    const result = spawnSync(
      process.execPath,
      [path.join(import.meta.dirname, 'staging-rollout.mjs'), 'phase1'],
      { encoding: 'utf8', env: { STAGING_ALERT_EMAIL: 'invalid' } },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /STAGING_ALERT_EMAIL|ALLOWED_EMAILS/);
    assert.doesNotMatch(result.stderr, /Usage:/);
  });
});
