import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCdkArguments, parseServerlessContext } from './serverless-deploy.mjs';

const context = {
  awsAccount: '111111111111',
  awsRegion: 'ap-northeast-1',
  hostedZoneId: 'Z00000000000000000000',
  hostedZoneName: 'oshi-schedule.com',
  webDomainName: 'oshi-schedule.com',
  apiDomainName: 'api.oshi-schedule.com',
  certificateArn: 'arn:aws:acm:ap-northeast-1:111111111111:certificate/test',
  alertEmail: 'alerts@oshi-schedule.com',
  nextPublicSupabaseUrl: 'https://project.supabase.co',
  nextPublicSupabasePublishableKey: 'sb_publishable_test',
  googleClientId: '123.apps.googleusercontent.com',
  supabaseServiceRoleSecretArn: 'arn:supabase',
  googleClientSecretArn: 'arn:google',
  youtubeApiKeySecretArn: 'arn:youtube',
  tokenEncryptionKeysSecretArn: 'arn:keys',
  databaseUrlSecretArn: 'arn:database',
  databaseMigrationUrlSecretArn: 'arn:migration',
  githubOwner: 'owner',
  githubRepository: 'repo',
  amplifyConnectionPhase: 'connected',
};

describe('serverless deploy context', () => {
  it('builds a production deploy without legacy runtime controls', () => {
    const parsed = parseServerlessContext('production', JSON.stringify(context));
    const args = buildCdkArguments('deploy', 'production', parsed);
    assert.ok(args.includes('runtimeArchitecture=serverless'));
    assert.ok(args.includes('backupRetentionDays=7'));
    assert.ok(args.includes('confirmProduction=DEPLOY_PRODUCTION'));
    assert.ok(!args.some((value) => /imageTag|rds|ecs|pipe/i.test(value)));
  });

  it('rejects legacy or unexpected settings', () => {
    assert.throws(
      () => parseServerlessContext('production', JSON.stringify({ ...context, imageTag: 'x' })),
      /unexpected/,
    );
  });
});
