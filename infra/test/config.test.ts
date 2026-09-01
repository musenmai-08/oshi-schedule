import { App } from 'aws-cdk-lib';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  loadConfig,
  parseAmplifyConnectionPhase,
  parseRuntimeArchitecture,
  parseBooleanContext,
  parseNonNegativeIntegerContext,
  parseSyncPipeDesiredState,
  validateProductionIsolation,
} from '../lib/config.js';

describe('parseBooleanContext', () => {
  it.each([
    [true, false, true],
    ['true', false, true],
    [false, true, false],
    ['false', true, false],
    [undefined, true, true],
    [undefined, false, false],
  ] as const)('parses %j with default %j as %j', (value, defaultValue, expected) => {
    expect(parseBooleanContext('testFlag', value, defaultValue)).toBe(expected);
  });

  it.each(['TRUE', 'yes', '1', '', 'abc', 0, 1, null])('rejects invalid value %j', (value) => {
    expect(() => parseBooleanContext('testFlag', value, false)).toThrow(
      'CDK context testFlag must be true or false',
    );
  });
});

describe('parseNonNegativeIntegerContext', () => {
  it.each([
    [0, 0],
    ['0', 0],
    [1, 1],
    ['1', 1],
    [2, 2],
  ] as const)('parses %j as %j', (value, expected) => {
    expect(parseNonNegativeIntegerContext('apiDesiredCount', value, 0)).toBe(expected);
  });

  it.each([-1, '-1', 1.5, '1.5', 'invalid', Number.NaN, '', null])(
    'rejects invalid value %j',
    (value) => {
      expect(() => parseNonNegativeIntegerContext('apiDesiredCount', value, 0)).toThrow(
        'CDK context apiDesiredCount must be a non-negative integer',
      );
    },
  );
});

describe('parseSyncPipeDesiredState', () => {
  it.each(['STOPPED', 'RUNNING'] as const)('accepts %s', (value) => {
    expect(parseSyncPipeDesiredState(value, 'STOPPED')).toBe(value);
  });

  it.each(['stopped', 'running', 'STARTED', '', true, 1, null])('rejects %j', (value) => {
    expect(() => parseSyncPipeDesiredState(value, 'STOPPED')).toThrow(
      'CDK context syncPipeDesiredState must be STOPPED or RUNNING',
    );
  });
});

describe('parseAmplifyConnectionPhase', () => {
  it.each(['manual', 'domain-detached', 'detached', 'connected'] as const)(
    'accepts %s',
    (value) => {
      expect(parseAmplifyConnectionPhase(value, 'manual')).toBe(value);
    },
  );

  it.each(['', 'connection', 'DOMAIN-DETACHED', true, 1, null])('rejects %j', (value) => {
    expect(() => parseAmplifyConnectionPhase(value, 'manual')).toThrow(/amplifyConnectionPhase/);
  });
});

describe('parseRuntimeArchitecture', () => {
  it.each(['serverless', 'legacy-ecs'] as const)('accepts %s', (value) => {
    expect(parseRuntimeArchitecture(value)).toBe(value);
  });
  it.each(['ecs', 'lambda', '', true, null])('rejects %j', (value) => {
    expect(() => parseRuntimeArchitecture(value)).toThrow(/runtimeArchitecture/);
  });
});

describe('loadConfig', () => {
  const completeDeployContext = {
    environment: 'staging',
    deployReady: 'true',
    bootstrapOnly: 'false',
    runtimeArchitecture: 'serverless',
    awsAccount: '111111111111',
    awsRegion: 'ap-northeast-1',
    hostedZoneId: 'Z00000000000000000000',
    hostedZoneName: 'example.invalid',
    webDomainName: 'staging.example.invalid',
    apiDomainName: 'api.staging.example.invalid',
    certificateArn:
      'arn:aws:acm:ap-northeast-1:111111111111:certificate/00000000-0000-4000-8000-000000000000',
    alertEmail: 'alerts@example.invalid',
    nextPublicSupabaseUrl: 'https://supabase.example.invalid',
    nextPublicSupabasePublishableKey: 'sb_publishable_fixture',
    supabaseServiceRoleSecretArn:
      'arn:aws:secretsmanager:ap-northeast-1:111111111111:secret:oshi-schedule-staging/app/supabase-service-role-key-Ab12Cd',
    googleClientSecretArn:
      'arn:aws:secretsmanager:ap-northeast-1:111111111111:secret:oshi-schedule-staging/app/google-client-secret-Ef34Gh',
    youtubeApiKeySecretArn:
      'arn:aws:secretsmanager:ap-northeast-1:111111111111:secret:oshi-schedule-staging/app/youtube-api-key-Ij56Kl',
    tokenEncryptionKeysSecretArn:
      'arn:aws:secretsmanager:ap-northeast-1:111111111111:secret:oshi-schedule-staging/app/token-encryption-keys-Mn78Op',
    databaseUrlSecretArn:
      'arn:aws:secretsmanager:ap-northeast-1:111111111111:secret:oshi-schedule-staging/app/database-runtime-url-Qr12St',
    databaseMigrationUrlSecretArn:
      'arn:aws:secretsmanager:ap-northeast-1:111111111111:secret:oshi-schedule-staging/app/database-migration-url-Uv34Wx',
    githubOwner: 'example-owner',
    githubRepository: 'example-repository',
    amplifyConnectionPhase: 'manual',
    imageTag: `sha256:${'a'.repeat(64)}`,
  };
  const productionDeployContext = {
    ...completeDeployContext,
    environment: 'production',
    confirmProduction: 'DEPLOY_PRODUCTION',
    applicationActivated: 'true',
    apiDesiredCount: '1',
    syncPipeDesiredState: 'RUNNING',
    hostedZoneName: 'oshi-schedule.com',
    webDomainName: 'oshi-schedule.com',
    apiDomainName: 'api.oshi-schedule.com',
    certificateArn:
      'arn:aws:acm:ap-northeast-1:111111111111:certificate/11111111-1111-4111-8111-111111111111',
    alertEmail: 'alerts@oshi-schedule.com',
    nextPublicSupabaseUrl: 'https://production-ref.supabase.co',
    nextPublicSupabasePublishableKey: 'sb_publishable_prodabc123',
    googleClientId: '1234567890-prodabc123.apps.googleusercontent.com',
    amplifyConnectionPhase: 'connected',
    supabaseServiceRoleSecretArn:
      'arn:aws:secretsmanager:ap-northeast-1:111111111111:secret:oshi-schedule-production/app/supabase-service-role-key-Ab12Cd',
    googleClientSecretArn:
      'arn:aws:secretsmanager:ap-northeast-1:111111111111:secret:oshi-schedule-production/app/google-client-secret-Ef34Gh',
    youtubeApiKeySecretArn:
      'arn:aws:secretsmanager:ap-northeast-1:111111111111:secret:oshi-schedule-production/app/youtube-api-key-Ij56Kl',
    tokenEncryptionKeysSecretArn:
      'arn:aws:secretsmanager:ap-northeast-1:111111111111:secret:oshi-schedule-production/app/token-encryption-keys-Mn78Op',
    databaseUrlSecretArn:
      'arn:aws:secretsmanager:ap-northeast-1:111111111111:secret:oshi-schedule-production/app/database-runtime-url-Qr12St',
    databaseMigrationUrlSecretArn:
      'arn:aws:secretsmanager:ap-northeast-1:111111111111:secret:oshi-schedule-production/app/database-migration-url-Uv34Wx',
  };

  it('synthesizes staging without a purchased domain', () => {
    const app = new App({ context: { environment: 'staging' } });
    const config = loadConfig(app);
    expect(config.deployReady).toBe(false);
    expect(config.bootstrapOnly).toBe(false);
    expect(config.apiDesiredCount).toBe(0);
    expect(config.syncPipeDesiredState).toBe('STOPPED');
    expect(config.applicationActivated).toBe(false);
    expect(config.amplifyConnectionPhase).toBe('manual');
    expect(config.webDomainName).toBeUndefined();
    expect(config.monthlyBudgetUsd).toBe(25);
  });

  it('does not apply the staging budget default to production', () => {
    const app = new App({
      context: { environment: 'production', confirmProduction: 'DEPLOY_PRODUCTION' },
    });
    expect(loadConfig(app)).toMatchObject({
      monthlyBudgetUsd: 20,
      apiDesiredCount: 1,
      syncPipeDesiredState: 'RUNNING',
      applicationActivated: true,
      amplifyConnectionPhase: 'connected',
      rdsBackupRetentionDays: 7,
    });
  });

  it('requires seven-day S3 backup retention in serverless production', () => {
    expect(() =>
      loadConfig(new App({ context: { ...productionDeployContext, backupRetentionDays: 1 } })),
    ).toThrow(/serverless architecture requires backupRetentionDays=7/);
  });

  it('supports an explicit environment budget override', () => {
    const app = new App({
      context: { environment: 'staging', monthlyBudgetUsd: 45 },
    });
    expect(loadConfig(app).monthlyBudgetUsd).toBe(45);
  });

  it('rejects deployReady when mandatory deployment inputs are absent', () => {
    const app = new App({ context: { environment: 'staging', deployReady: 'true' } });
    expect(() => loadConfig(app)).toThrow(/requires context/);
  });

  it('accepts complete application Secret ARNs for a full deploy', () => {
    expect(loadConfig(new App({ context: completeDeployContext }))).toMatchObject({
      googleClientSecretArn: completeDeployContext.googleClientSecretArn,
      youtubeApiKeySecretArn: completeDeployContext.youtubeApiKeySecretArn,
    });
  });

  it.each([
    [
      'a suffix-less partial ARN',
      {
        googleClientSecretArn:
          'arn:aws:secretsmanager:ap-northeast-1:111111111111:secret:oshi-schedule-staging/app/google-client-secret',
      },
    ],
    [
      'an ARN for another Secret name',
      {
        googleClientSecretArn:
          'arn:aws:secretsmanager:ap-northeast-1:111111111111:secret:oshi-schedule-staging/app/youtube-api-key-Ab12Cd',
      },
    ],
    [
      'an ARN from another account',
      {
        googleClientSecretArn:
          'arn:aws:secretsmanager:ap-northeast-1:999999999999:secret:oshi-schedule-staging/app/google-client-secret-Ab12Cd',
      },
    ],
  ])('rejects %s before synth', (_name, patch) => {
    expect(() => loadConfig(new App({ context: { ...completeDeployContext, ...patch } }))).toThrow(
      /googleClientSecretArn must be the complete ARN/,
    );
  });

  it('requires production-specific Secret ARNs instead of accepting staging ARNs', () => {
    const productionContext = {
      ...productionDeployContext,
      supabaseServiceRoleSecretArn: completeDeployContext.supabaseServiceRoleSecretArn,
      googleClientSecretArn: completeDeployContext.googleClientSecretArn,
      youtubeApiKeySecretArn: completeDeployContext.youtubeApiKeySecretArn,
      tokenEncryptionKeysSecretArn: completeDeployContext.tokenEncryptionKeysSecretArn,
    };
    expect(() => loadConfig(new App({ context: productionContext }))).toThrow(
      /supabaseServiceRoleSecretArn must be the complete ARN for oshi-schedule-production/,
    );

    expect(loadConfig(new App({ context: productionDeployContext }))).toMatchObject({
      environmentName: 'production',
      googleClientId: productionDeployContext.googleClientId,
    });
  });

  it('requires the production Google client ID as a managed public input', () => {
    const context = { ...productionDeployContext };
    delete (context as Partial<typeof context>).googleClientId;
    expect(() => loadConfig(new App({ context }))).toThrow(/requires context: googleClientId/);
  });

  it('does not allow production Web builds to override their API custom-domain origin', () => {
    expect(() =>
      loadConfig(
        new App({
          context: {
            ...productionDeployContext,
            webApiOrigin: 'https://preview.execute-api.ap-northeast-1.amazonaws.com',
          },
        }),
      ),
    ).toThrow(/production webApiOrigin must equal the configured apiDomainName origin/);
  });

  it.each([
    ['webDomainName', 'staging.oshi-schedule.com'],
    ['apiDomainName', 'api-staging.oshi-schedule.com'],
    [
      'certificateArn',
      'arn:aws:acm:ap-northeast-1:741448960817:certificate/34f4c02d-769a-4bfa-b85d-829a6ed67774',
    ],
    ['nextPublicSupabaseUrl', 'https://staging-ref.supabase.co'],
    ['nextPublicSupabasePublishableKey', 'sb_publishable_staging_fixture'],
    ['googleClientId', '1234567890-stagingfixture.apps.googleusercontent.com'],
  ] as const)('rejects a fingerprinted staging %s in production', (key, value) => {
    const config = loadConfig(new App({ context: productionDeployContext }));
    const fingerprints = Object.fromEntries(
      [
        'webDomainName',
        'apiDomainName',
        'certificateArn',
        'nextPublicSupabaseUrl',
        'nextPublicSupabasePublishableKey',
        'googleClientId',
      ].map((name) => [
        name,
        name === key
          ? `sha256:${createHash('sha256').update(value).digest('hex')}`
          : 'sha256:not-the-staging-value',
      ]),
    ) as Parameters<typeof validateProductionIsolation>[1];

    expect(() => validateProductionIsolation({ ...config, [key]: value }, fingerprints)).toThrow(
      new RegExp(`production ${key} must not reuse the staging value`),
    );
  });

  it.each([
    ['webDomainName', 'localhost'],
    ['webDomainName', 'app.example.com'],
    ['webDomainName', 'dev.oshi-schedule.com'],
    ['webDomainName', 'app.oshi-schedule.com'],
    ['apiDomainName', 'api2.oshi-schedule.com'],
    ['nextPublicSupabaseUrl', 'http://127.0.0.1:54321'],
    ['nextPublicSupabaseUrl', 'https://test.supabase.co'],
  ] as const)('rejects production development or placeholder %s=%s', (key, value) => {
    expect(() =>
      loadConfig(new App({ context: { ...productionDeployContext, [key]: value } })),
    ).toThrow(/production/);
  });

  it('rejects a production certificate from another account or region', () => {
    expect(() =>
      loadConfig(
        new App({
          context: {
            ...productionDeployContext,
            certificateArn:
              'arn:aws:acm:us-east-1:999999999999:certificate/11111111-1111-4111-8111-111111111111',
          },
        }),
      ),
    ).toThrow(/certificateArn must match the configured account and region/);
  });

  it('keeps synth-only behavior when deployReady is the CLI string false', () => {
    const app = new App({ context: { environment: 'staging', deployReady: 'false' } });
    expect(loadConfig(app).deployReady).toBe(false);
  });

  it('parses CLI boolean strings for bootstrap, RDS, and worker settings', () => {
    const app = new App({
      context: {
        environment: 'staging',
        deployReady: 'true',
        bootstrapOnly: 'true',
        awsAccount: '111111111111',
        rdsMultiAz: 'true',
        rdsDeletionProtection: 'false',
        workerScheduleEnabled: 'true',
      },
    });
    expect(loadConfig(app)).toMatchObject({
      deployReady: true,
      bootstrapOnly: true,
      rdsMultiAz: true,
      rdsDeletionProtection: false,
      workerScheduleEnabled: true,
    });
  });

  it('requires an explicit production acknowledgement', () => {
    const app = new App({ context: { environment: 'production' } });
    expect(() => loadConfig(app)).toThrow(/confirmProduction=DEPLOY_PRODUCTION/);
  });

  it('does not allow staging Amplify transition phases in production', () => {
    const app = new App({
      context: {
        environment: 'production',
        confirmProduction: 'DEPLOY_PRODUCTION',
        amplifyConnectionPhase: 'detached',
      },
    });
    expect(() => loadConfig(app)).toThrow(/production requires amplifyConnectionPhase=connected/);
  });

  it('rejects application activation bypasses outside bootstrap-only mode', () => {
    expect(() =>
      loadConfig(
        new App({
          context: {
            environment: 'staging',
            apiDesiredCount: 1,
            syncPipeDesiredState: 'STOPPED',
            applicationActivated: false,
          },
        }),
      ),
    ).toThrow(/applicationActivated=false requires/);
    expect(() =>
      loadConfig(
        new App({
          context: {
            environment: 'staging',
            apiDesiredCount: 0,
            syncPipeDesiredState: 'RUNNING',
            applicationActivated: false,
          },
        }),
      ),
    ).toThrow(/applicationActivated=false requires/);
  });

  it('does not require full rollout state for bootstrap-only synth', () => {
    const config = loadConfig(
      new App({
        context: {
          environment: 'staging',
          bootstrapOnly: true,
          apiDesiredCount: 2,
          syncPipeDesiredState: 'RUNNING',
          applicationActivated: false,
        },
      }),
    );
    expect(config.bootstrapOnly).toBe(true);
  });
});
