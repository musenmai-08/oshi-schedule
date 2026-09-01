import { spawn } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const allowedKeys = new Set([
  'awsAccount',
  'awsRegion',
  'hostedZoneId',
  'hostedZoneName',
  'webDomainName',
  'apiDomainName',
  'certificateArn',
  'alertEmail',
  'nextPublicSupabaseUrl',
  'nextPublicSupabasePublishableKey',
  'googleClientId',
  'supabaseServiceRoleSecretArn',
  'googleClientSecretArn',
  'youtubeApiKeySecretArn',
  'tokenEncryptionKeysSecretArn',
  'databaseUrlSecretArn',
  'databaseMigrationUrlSecretArn',
  'githubOwner',
  'githubRepository',
  'amplifyConnectionPhase',
  'monthlyBudgetUsd',
  'workerScheduleEnabled',
]);

const requiredKeys = [...allowedKeys].filter(
  (key) => key !== 'workerScheduleEnabled' && key !== 'monthlyBudgetUsd',
);

export const parseServerlessContext = (environment, text) => {
  if (!['staging', 'production'].includes(environment))
    throw new Error('environment must be staging or production');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('serverless context must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('serverless context must be an object');
  const unexpected = Object.keys(parsed).filter((key) => !allowedKeys.has(key));
  if (unexpected.length) throw new Error(`unexpected serverless context: ${unexpected.join(', ')}`);
  const missing = requiredKeys.filter(
    (key) => typeof parsed[key] !== 'string' || parsed[key].trim() === '',
  );
  if (missing.length) throw new Error(`missing serverless context: ${missing.join(', ')}`);
  if (environment === 'production') {
    if (parsed.webDomainName !== 'oshi-schedule.com')
      throw new Error('production webDomainName must be oshi-schedule.com');
    if (parsed.apiDomainName !== 'api.oshi-schedule.com')
      throw new Error('production apiDomainName must be api.oshi-schedule.com');
    if (parsed.amplifyConnectionPhase !== 'connected')
      throw new Error('production Amplify must be connected');
  }
  return parsed;
};

export const buildCdkArguments = (operation, environment, context) => {
  if (!['synth', 'diff', 'deploy'].includes(operation))
    throw new Error('operation must be synth, diff, or deploy');
  const values = {
    ...context,
    environment,
    runtimeArchitecture: 'serverless',
    serverlessStagingMode: environment === 'staging' ? 'preview' : 'cutover',
    backupRetentionDays: 7,
    deployReady: true,
    bootstrapOnly: false,
    applicationActivated: true,
    ...(environment === 'production' ? { confirmProduction: 'DEPLOY_PRODUCTION' } : {}),
  };
  return [
    'aws:cdk',
    operation,
    environment === 'staging' ? 'oshi-schedule-staging-serverless' : 'oshi-schedule-production',
    ...Object.entries(values).flatMap(([key, value]) => ['-c', `${key}=${String(value)}`]),
    ...(operation === 'deploy' ? ['--require-approval', 'never'] : []),
  ];
};

const main = async () => {
  const [operation, environment, text] = process.argv.slice(2);
  if (!operation || !environment || !text)
    throw new Error(
      'usage: serverless-deploy.mjs <synth|diff|deploy> <environment> <context-json>',
    );
  const context = parseServerlessContext(environment, text);
  const child = spawn('pnpm', buildCdkArguments(operation, environment, context), {
    stdio: 'inherit',
    env: process.env,
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'serverless deployment failed');
    process.exitCode = 1;
  });
