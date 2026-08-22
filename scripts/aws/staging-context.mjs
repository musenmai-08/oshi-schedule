import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(scriptDirectory, '../..');
export const defaultConfigPath = path.join(projectRoot, 'infra/config/staging-deploy.json');
export const defaultEnvPath = path.join(projectRoot, '.env');

export const repositoryContextKeys = Object.freeze([
  'environment',
  'deployReady',
  'bootstrapOnly',
  'awsAccount',
  'awsRegion',
  'hostedZoneId',
  'hostedZoneName',
  'webDomainName',
  'apiDomainName',
  'certificateArn',
  'supabaseServiceRoleSecretArn',
  'googleClientSecretArn',
  'youtubeApiKeySecretArn',
  'tokenEncryptionKeysSecretArn',
  'monthlyBudgetUsd',
  'githubOwner',
  'githubRepository',
  'amplifyConnectionPhase',
  'imageTag',
  'apiCpu',
  'apiMemoryMiB',
  'workerCpu',
  'workerMemoryMiB',
  'rdsInstanceType',
  'rdsAllocatedStorageGiB',
  'rdsBackupRetentionDays',
  'rdsMultiAz',
  'rdsDeletionProtection',
  'workerScheduleEnabled',
]);

export const externalContextKeys = Object.freeze([
  'alertEmail',
  'nextPublicSupabaseUrl',
  'nextPublicSupabasePublishableKey',
]);

export const phaseContext = Object.freeze({
  phase1: Object.freeze({
    apiDesiredCount: 0,
    syncPipeDesiredState: 'STOPPED',
    applicationActivated: false,
  }),
  phase2: Object.freeze({
    apiDesiredCount: 1,
    syncPipeDesiredState: 'RUNNING',
    applicationActivated: true,
  }),
});

export const phaseContextKeys = Object.freeze(Object.keys(phaseContext.phase1));
export const managedContextKeys = Object.freeze([
  ...repositoryContextKeys,
  ...externalContextKeys,
  ...phaseContextKeys,
]);

const fail = (message) => {
  throw new Error(`Invalid staging deploy context: ${message}`);
};

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const requireString = (context, key) => {
  const value = context[key];
  if (typeof value !== 'string' || value.trim() === '') fail(`${key} is required`);
  return value;
};

const requireBoolean = (context, key) => {
  if (typeof context[key] !== 'boolean') fail(`${key} must be a boolean`);
};

const requireInteger = (context, key, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) => {
  const value = context[key];
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    fail(`${key} must be an integer between ${minimum} and ${maximum}`);
};

const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const applicationSecretArnDefinitions = Object.freeze([
  ['supabaseServiceRoleSecretArn', 'app/supabase-service-role-key'],
  ['googleClientSecretArn', 'app/google-client-secret'],
  ['youtubeApiKeySecretArn', 'app/youtube-api-key'],
  ['tokenEncryptionKeysSecretArn', 'app/token-encryption-keys'],
]);

const escapeRegularExpression = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const validateRepositoryContext = (context) => {
  if (!isPlainObject(context)) fail('repository config must be a JSON object');
  const keys = Object.keys(context).sort();
  const expected = [...repositoryContextKeys].sort();
  const missing = expected.filter((key) => !keys.includes(key));
  const unexpected = keys.filter((key) => !expected.includes(key));
  if (missing.length > 0) fail(`missing repository keys: ${missing.join(', ')}`);
  if (unexpected.length > 0) fail(`unexpected repository keys: ${unexpected.join(', ')}`);

  if (context.environment !== 'staging') fail('environment must be staging');
  requireBoolean(context, 'deployReady');
  requireBoolean(context, 'bootstrapOnly');
  if (!context.deployReady) fail('deployReady must be true');
  if (context.bootstrapOnly) fail('bootstrapOnly must be false');

  const account = requireString(context, 'awsAccount');
  const region = requireString(context, 'awsRegion');
  if (!/^\d{12}$/.test(account)) fail('awsAccount must be a 12-digit account ID');
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) fail('awsRegion is malformed');
  if (!/^Z[A-Z0-9]+$/.test(requireString(context, 'hostedZoneId')))
    fail('hostedZoneId is malformed');

  for (const key of ['hostedZoneName', 'webDomainName', 'apiDomainName']) {
    if (!domainPattern.test(requireString(context, key))) fail(`${key} is malformed`);
  }
  if (!context.webDomainName.endsWith(`.${context.hostedZoneName}`))
    fail('webDomainName must belong to hostedZoneName');
  if (!context.apiDomainName.endsWith(`.${context.hostedZoneName}`))
    fail('apiDomainName must belong to hostedZoneName');

  const certificateArn = requireString(context, 'certificateArn');
  const certificatePattern = new RegExp(
    `^arn:(?:aws|aws-us-gov|aws-cn):acm:${region}:${account}:certificate/` +
      '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  );
  if (!certificatePattern.test(certificateArn)) fail('certificateArn is malformed or mismatched');
  for (const [key, secretNameSuffix] of applicationSecretArnDefinitions) {
    const expectedSecretName = `oshi-schedule-staging/${secretNameSuffix}`;
    const completeArnPattern = new RegExp(
      `^arn:(?:aws|aws-us-gov|aws-cn):secretsmanager:${escapeRegularExpression(region)}:` +
        `${escapeRegularExpression(account)}:secret:${escapeRegularExpression(expectedSecretName)}-[A-Za-z0-9]{6}$`,
    );
    if (!completeArnPattern.test(requireString(context, key))) {
      fail(`${key} must be the complete ARN for ${expectedSecretName}`);
    }
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(requireString(context, 'imageTag')))
    fail('imageTag must be an immutable sha256 digest');

  requireInteger(context, 'monthlyBudgetUsd', { minimum: 1, maximum: 10_000 });
  for (const key of ['apiCpu', 'apiMemoryMiB', 'workerCpu', 'workerMemoryMiB'])
    requireInteger(context, key, { minimum: 1, maximum: 65_536 });
  requireInteger(context, 'rdsAllocatedStorageGiB', { minimum: 20, maximum: 65_536 });
  requireInteger(context, 'rdsBackupRetentionDays', { minimum: 0, maximum: 35 });
  requireBoolean(context, 'rdsMultiAz');
  requireBoolean(context, 'rdsDeletionProtection');
  requireBoolean(context, 'workerScheduleEnabled');
  if (context.workerScheduleEnabled) fail('workerScheduleEnabled must remain false for staging');
  if (!/^[a-z0-9.]+$/.test(requireString(context, 'rdsInstanceType')))
    fail('rdsInstanceType is malformed');
  if (!/^[A-Za-z0-9_.-]+$/.test(requireString(context, 'githubOwner')))
    fail('githubOwner is malformed');
  if (!/^[A-Za-z0-9_.-]+$/.test(requireString(context, 'githubRepository')))
    fail('githubRepository is malformed');
  if (
    !['manual', 'domain-detached', 'detached', 'connected'].includes(context.amplifyConnectionPhase)
  )
    fail('amplifyConnectionPhase must be manual, domain-detached, detached, or connected');
  return context;
};

const parseEnvFile = (source) => {
  const parsed = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    )
      value = value.slice(1, -1);
    parsed[key] = value;
  }
  return parsed;
};

const readOptionalEnvFile = async (envPath) => {
  try {
    return parseEnvFile(await readFile(envPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
};

export const loadExternalContext = async ({ env = process.env, envPath = defaultEnvPath } = {}) => {
  const fileEnv = await readOptionalEnvFile(envPath);
  const get = (key) => env[key]?.trim() || fileEnv[key]?.trim() || '';
  const allowedEmails = get('ALLOWED_EMAILS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const alertEmail = get('STAGING_ALERT_EMAIL') || allowedEmails[0] || '';
  const nextPublicSupabaseUrl = get('NEXT_PUBLIC_SUPABASE_URL');
  const nextPublicSupabasePublishableKey = get('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');

  if (!emailPattern.test(alertEmail))
    fail('STAGING_ALERT_EMAIL or the first ALLOWED_EMAILS entry must be a valid email');
  let parsedUrl;
  try {
    parsedUrl = new URL(nextPublicSupabaseUrl);
  } catch {
    fail('NEXT_PUBLIC_SUPABASE_URL must be a valid URL');
  }
  if (parsedUrl.protocol !== 'https:') fail('NEXT_PUBLIC_SUPABASE_URL must use https');
  if (
    !/^sb_publishable_[A-Za-z0-9_-]+$/.test(nextPublicSupabasePublishableKey) &&
    !/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(nextPublicSupabasePublishableKey)
  )
    fail('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is malformed');

  return { alertEmail, nextPublicSupabaseUrl, nextPublicSupabasePublishableKey };
};

export const loadRepositoryContext = async (configPath = defaultConfigPath) => {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`repository config is missing: ${configPath}`);
    fail(`repository config is not valid JSON: ${error.message}`);
  }
  return validateRepositoryContext(parsed);
};

export const loadCommonContext = async (options = {}) => ({
  ...(await loadRepositoryContext(options.configPath)),
  ...(await loadExternalContext(options)),
});

export const buildPhaseContext = (common, phase) => {
  const phaseValues = phaseContext[phase];
  if (!phaseValues) fail(`phase must be phase1 or phase2, got ${phase || '(empty)'}`);
  return { ...common, ...phaseValues };
};

export const toCdkContextArgs = (context) =>
  [...repositoryContextKeys, ...externalContextKeys, ...phaseContextKeys].flatMap((key) => [
    '-c',
    `${key}=${String(context[key])}`,
  ]);

const canonicalRepositoryContext = (context) =>
  Object.fromEntries(repositoryContextKeys.map((key) => [key, context[key]]));

export const commonContextFingerprint = (context) =>
  `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalRepositoryContext(context)))
    .digest('hex')}`;

export const formatContextSummary = (common, phase) => {
  const complete = buildPhaseContext(common, phase);
  const masked = {
    ...complete,
    alertEmail: '<masked>',
    nextPublicSupabasePublishableKey: '<masked>',
  };
  return [
    `Common context fingerprint: ${commonContextFingerprint(common)}`,
    ...[...repositoryContextKeys, ...externalContextKeys, ...phaseContextKeys].map(
      (key) => `${key}=${String(masked[key])}`,
    ),
  ].join('\n');
};

const runCli = async () => {
  const argumentsWithoutSeparator = process.argv.slice(2).filter((argument) => argument !== '--');
  const [command = 'show', phase = 'phase1'] = argumentsWithoutSeparator;
  if (command !== 'show') throw new Error('Usage: staging-context.mjs show <phase1|phase2>');
  const common = await loadCommonContext();
  process.stdout.write(`${formatContextSummary(common, phase)}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
