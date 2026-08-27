import type { App } from 'aws-cdk-lib';
import { createHash } from 'node:crypto';
import {
  stagingPublicIdentifierFingerprints,
  type StagingPublicIdentifierFingerprints,
} from './environment-boundary.js';

export type EnvironmentName = 'staging' | 'production';
export type SyncPipeDesiredState = 'STOPPED' | 'RUNNING';
export type AmplifyConnectionPhase = 'manual' | 'domain-detached' | 'detached' | 'connected';

export const applicationSecretArnDefinitions = [
  {
    contextKey: 'supabaseServiceRoleSecretArn',
    environmentVariable: 'SUPABASE_SERVICE_ROLE_KEY',
    constructId: 'SupabaseServiceRoleSecret',
    secretNameSuffix: 'app/supabase-service-role-key',
  },
  {
    contextKey: 'googleClientSecretArn',
    environmentVariable: 'GOOGLE_CLIENT_SECRET',
    constructId: 'GoogleClientSecret',
    secretNameSuffix: 'app/google-client-secret',
  },
  {
    contextKey: 'youtubeApiKeySecretArn',
    environmentVariable: 'YOUTUBE_API_KEY',
    constructId: 'YoutubeApiKeySecret',
    secretNameSuffix: 'app/youtube-api-key',
  },
  {
    contextKey: 'tokenEncryptionKeysSecretArn',
    environmentVariable: 'TOKEN_ENCRYPTION_KEYS',
    constructId: 'TokenEncryptionKeysSecret',
    secretNameSuffix: 'app/token-encryption-keys',
  },
] as const;

export interface DeploymentConfig {
  environmentName: EnvironmentName;
  account?: string;
  region: string;
  deployReady: boolean;
  bootstrapOnly: boolean;
  apiDesiredCount: number;
  syncPipeDesiredState: SyncPipeDesiredState;
  applicationActivated: boolean;
  hostedZoneId?: string;
  hostedZoneName?: string;
  webDomainName?: string;
  apiDomainName?: string;
  certificateArn?: string;
  alertEmail?: string;
  nextPublicSupabaseUrl?: string;
  nextPublicSupabasePublishableKey?: string;
  googleClientId?: string;
  supabaseServiceRoleSecretArn?: string;
  googleClientSecretArn?: string;
  youtubeApiKeySecretArn?: string;
  tokenEncryptionKeysSecretArn?: string;
  monthlyBudgetUsd: number;
  githubOwner: string;
  githubRepository: string;
  amplifyConnectionPhase: AmplifyConnectionPhase;
  imageTag: string;
  apiCpu: number;
  apiMemoryMiB: number;
  workerCpu: number;
  workerMemoryMiB: number;
  rdsInstanceType: string;
  rdsAllocatedStorageGiB: number;
  rdsBackupRetentionDays: number;
  rdsMultiAz: boolean;
  rdsDeletionProtection: boolean;
  workerScheduleEnabled: boolean;
}

const optionalString = (app: App, name: string): string | undefined => {
  const value = app.node.tryGetContext(name);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
};

export const parseBooleanContext = (
  name: string,
  value: unknown,
  defaultValue: boolean,
): boolean => {
  if (value === undefined) return defaultValue;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`CDK context ${name} must be true or false`);
};

export const parseNonNegativeIntegerContext = (
  name: string,
  value: unknown,
  defaultValue: number,
): number => {
  if (
    value !== undefined &&
    typeof value !== 'number' &&
    (typeof value !== 'string' || value.trim() === '')
  ) {
    throw new Error(`CDK context ${name} must be a non-negative integer`);
  }
  const parsed = value === undefined ? defaultValue : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`CDK context ${name} must be a non-negative integer`);
  }
  return parsed;
};

export const parseSyncPipeDesiredState = (
  value: unknown,
  defaultValue: SyncPipeDesiredState,
): SyncPipeDesiredState => {
  const parsed = value === undefined ? defaultValue : value;
  if (parsed !== 'STOPPED' && parsed !== 'RUNNING') {
    throw new Error('CDK context syncPipeDesiredState must be STOPPED or RUNNING');
  }
  return parsed;
};

export const parseAmplifyConnectionPhase = (
  value: unknown,
  defaultValue: AmplifyConnectionPhase,
): AmplifyConnectionPhase => {
  const parsed = value === undefined ? defaultValue : value;
  if (!['manual', 'domain-detached', 'detached', 'connected'].includes(String(parsed))) {
    throw new Error(
      'CDK context amplifyConnectionPhase must be manual, domain-detached, detached, or connected',
    );
  }
  return parsed as AmplifyConnectionPhase;
};

const requiredForDeploy = (config: DeploymentConfig, name: keyof DeploymentConfig): void => {
  if (config[name] === undefined || config[name] === '') {
    throw new Error(`CDK deploy requires context: ${String(name)}`);
  }
};

const escapeRegularExpression = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const sha256Fingerprint = (value: string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const nonProductionDomainLabel =
  /(^|[.-])(staging|stage|test|testing|dev|development|local)([.-]|$)/;
const reservedHostname = /(^|\.)(localhost|example\.(?:com|net|org)|invalid|local)$/;
const localAddress = /^(?:127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1)$/;
const placeholderHostnameLabel =
  /(^|[.-])(example|placeholder|replace|replace-me|required|your-project|project-ref)([.-]|$)/;
const placeholderValue =
  /(?:required|replace[_-]?me|placeholder|example|fixture|your[-_]?project)/i;

const validateProductionDomain = (
  name: 'hostedZoneName' | 'webDomainName' | 'apiDomainName',
  value: string,
): void => {
  const hostname = value.toLowerCase();
  if (!domainPattern.test(hostname)) throw new Error(`production ${name} must be a valid DNS name`);
  if (
    reservedHostname.test(hostname) ||
    localAddress.test(hostname) ||
    placeholderHostnameLabel.test(hostname) ||
    nonProductionDomainLabel.test(hostname)
  ) {
    throw new Error(`production ${name} must not use a staging, development, or reserved hostname`);
  }
};

const validateProductionHttpsOrigin = (name: string, value: string): URL => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`production ${name} must be a valid HTTPS origin`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(`production ${name} must be a valid HTTPS origin`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    reservedHostname.test(hostname) ||
    localAddress.test(hostname) ||
    placeholderHostnameLabel.test(hostname) ||
    nonProductionDomainLabel.test(hostname)
  ) {
    throw new Error(`production ${name} must not use a staging, development, or reserved host`);
  }
  return parsed;
};

export const validateProductionIsolation = (
  config: DeploymentConfig,
  stagingFingerprints: StagingPublicIdentifierFingerprints = stagingPublicIdentifierFingerprints,
): void => {
  if (config.environmentName !== 'production') return;
  if (!config.account || !/^\d{12}$/.test(config.account))
    throw new Error('production account must be a 12-digit AWS account ID');
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(config.region))
    throw new Error('production region is malformed');
  if (config.hostedZoneId && !/^Z[A-Z0-9]+$/.test(config.hostedZoneId))
    throw new Error('production hostedZoneId is malformed');
  const required = {
    webDomainName: config.webDomainName,
    apiDomainName: config.apiDomainName,
    certificateArn: config.certificateArn,
    nextPublicSupabaseUrl: config.nextPublicSupabaseUrl,
    nextPublicSupabasePublishableKey: config.nextPublicSupabasePublishableKey,
    googleClientId: config.googleClientId,
  } as const;

  for (const [name, value] of Object.entries(required)) {
    if (!value) continue;
    if (sha256Fingerprint(value) === stagingFingerprints[name as keyof typeof required]) {
      throw new Error(`production ${name} must not reuse the staging value`);
    }
  }

  if (config.hostedZoneName) validateProductionDomain('hostedZoneName', config.hostedZoneName);
  if (config.webDomainName) validateProductionDomain('webDomainName', config.webDomainName);
  if (config.apiDomainName) validateProductionDomain('apiDomainName', config.apiDomainName);
  if (config.hostedZoneName && config.webDomainName) {
    if (
      config.webDomainName !== config.hostedZoneName &&
      !config.webDomainName.endsWith(`.${config.hostedZoneName}`)
    )
      throw new Error('production webDomainName must belong to hostedZoneName');
  }
  if (config.hostedZoneName && config.apiDomainName) {
    if (
      config.apiDomainName !== config.hostedZoneName &&
      !config.apiDomainName.endsWith(`.${config.hostedZoneName}`)
    )
      throw new Error('production apiDomainName must belong to hostedZoneName');
  }
  if (config.webDomainName && config.apiDomainName && config.webDomainName === config.apiDomainName)
    throw new Error('production webDomainName and apiDomainName must be different');

  if (config.nextPublicSupabaseUrl)
    validateProductionHttpsOrigin('nextPublicSupabaseUrl', config.nextPublicSupabaseUrl);
  if (
    config.nextPublicSupabasePublishableKey &&
    (placeholderValue.test(config.nextPublicSupabasePublishableKey) ||
      (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.nextPublicSupabasePublishableKey) &&
        !/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
          config.nextPublicSupabasePublishableKey,
        )))
  )
    throw new Error('production nextPublicSupabasePublishableKey is malformed');
  if (
    config.googleClientId &&
    (placeholderValue.test(config.googleClientId) ||
      !/^\d+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(config.googleClientId))
  )
    throw new Error('production googleClientId is malformed');
  if (config.alertEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.alertEmail))
    throw new Error('production alertEmail is malformed');
  if (!/^sha256:[0-9a-f]{64}$/.test(config.imageTag))
    throw new Error('production imageTag must be an immutable sha256 digest');
  if (config.account && config.certificateArn) {
    const certificatePattern = new RegExp(
      `^arn:(?:aws|aws-us-gov|aws-cn):acm:${escapeRegularExpression(config.region)}:` +
        `${escapeRegularExpression(config.account)}:certificate/[0-9a-f-]{36}$`,
    );
    if (!certificatePattern.test(config.certificateArn))
      throw new Error('production certificateArn must match the configured account and region');
  }
};

const validateApplicationSecretArns = (config: DeploymentConfig): void => {
  if (!config.account) throw new Error('CDK deploy requires context: account');

  for (const definition of applicationSecretArnDefinitions) {
    const value = config[definition.contextKey];
    if (!value) continue;
    const expectedSecretName = `oshi-schedule-${config.environmentName}/${definition.secretNameSuffix}`;
    const pattern = new RegExp(
      `^arn:(?:aws|aws-us-gov|aws-cn):secretsmanager:${escapeRegularExpression(config.region)}:` +
        `${escapeRegularExpression(config.account)}:secret:${escapeRegularExpression(expectedSecretName)}-[A-Za-z0-9]{6}$`,
    );
    if (!pattern.test(value)) {
      throw new Error(
        `CDK context ${definition.contextKey} must be the complete ARN for ${expectedSecretName}`,
      );
    }
  }
};

export const loadConfig = (app: App): DeploymentConfig => {
  const environmentName = optionalString(app, 'environment') ?? 'staging';
  if (environmentName !== 'staging' && environmentName !== 'production') {
    throw new Error('environment must be staging or production');
  }

  const config: DeploymentConfig = {
    environmentName,
    account: optionalString(app, 'awsAccount'),
    region: optionalString(app, 'awsRegion') ?? 'ap-northeast-1',
    deployReady: parseBooleanContext('deployReady', app.node.tryGetContext('deployReady'), false),
    bootstrapOnly: parseBooleanContext(
      'bootstrapOnly',
      app.node.tryGetContext('bootstrapOnly'),
      false,
    ),
    apiDesiredCount: parseNonNegativeIntegerContext(
      'apiDesiredCount',
      app.node.tryGetContext('apiDesiredCount'),
      environmentName === 'staging' ? 0 : 1,
    ),
    syncPipeDesiredState: parseSyncPipeDesiredState(
      app.node.tryGetContext('syncPipeDesiredState'),
      environmentName === 'staging' ? 'STOPPED' : 'RUNNING',
    ),
    applicationActivated: parseBooleanContext(
      'applicationActivated',
      app.node.tryGetContext('applicationActivated'),
      environmentName === 'production',
    ),
    hostedZoneId: optionalString(app, 'hostedZoneId'),
    hostedZoneName: optionalString(app, 'hostedZoneName'),
    webDomainName: optionalString(app, 'webDomainName'),
    apiDomainName: optionalString(app, 'apiDomainName'),
    certificateArn: optionalString(app, 'certificateArn'),
    alertEmail: optionalString(app, 'alertEmail'),
    nextPublicSupabaseUrl: optionalString(app, 'nextPublicSupabaseUrl'),
    nextPublicSupabasePublishableKey: optionalString(app, 'nextPublicSupabasePublishableKey'),
    googleClientId: optionalString(app, 'googleClientId'),
    supabaseServiceRoleSecretArn: optionalString(app, 'supabaseServiceRoleSecretArn'),
    googleClientSecretArn: optionalString(app, 'googleClientSecretArn'),
    youtubeApiKeySecretArn: optionalString(app, 'youtubeApiKeySecretArn'),
    tokenEncryptionKeysSecretArn: optionalString(app, 'tokenEncryptionKeysSecretArn'),
    monthlyBudgetUsd: Number(
      app.node.tryGetContext('monthlyBudgetUsd') ??
        app.node.tryGetContext(
          environmentName === 'staging' ? 'stagingMonthlyBudgetUsd' : 'productionMonthlyBudgetUsd',
        ) ??
        (environmentName === 'staging' ? 25 : 75),
    ),
    githubOwner: optionalString(app, 'githubOwner') ?? 'REQUIRED_GITHUB_OWNER',
    githubRepository: optionalString(app, 'githubRepository') ?? 'REQUIRED_GITHUB_REPOSITORY',
    amplifyConnectionPhase: parseAmplifyConnectionPhase(
      app.node.tryGetContext('amplifyConnectionPhase'),
      environmentName === 'staging' ? 'manual' : 'connected',
    ),
    imageTag: optionalString(app, 'imageTag') ?? 'bootstrap-required',
    apiCpu: Number(app.node.tryGetContext('apiCpu') ?? 256),
    apiMemoryMiB: Number(app.node.tryGetContext('apiMemoryMiB') ?? 512),
    workerCpu: Number(app.node.tryGetContext('workerCpu') ?? 256),
    workerMemoryMiB: Number(app.node.tryGetContext('workerMemoryMiB') ?? 512),
    rdsInstanceType: optionalString(app, 'rdsInstanceType') ?? 't4g.micro',
    rdsAllocatedStorageGiB: Number(app.node.tryGetContext('rdsAllocatedStorageGiB') ?? 20),
    rdsBackupRetentionDays: Number(app.node.tryGetContext('rdsBackupRetentionDays') ?? 1),
    rdsMultiAz: parseBooleanContext('rdsMultiAz', app.node.tryGetContext('rdsMultiAz'), false),
    rdsDeletionProtection: parseBooleanContext(
      'rdsDeletionProtection',
      app.node.tryGetContext('rdsDeletionProtection'),
      true,
    ),
    workerScheduleEnabled: parseBooleanContext(
      'workerScheduleEnabled',
      app.node.tryGetContext('workerScheduleEnabled'),
      false,
    ),
  };

  if (!Number.isFinite(config.monthlyBudgetUsd) || config.monthlyBudgetUsd <= 0) {
    throw new Error('monthlyBudgetUsd must be a positive number');
  }
  if (environmentName === 'production' && config.amplifyConnectionPhase !== 'connected') {
    throw new Error('production requires amplifyConnectionPhase=connected');
  }
  if (
    !config.bootstrapOnly &&
    !config.applicationActivated &&
    (config.apiDesiredCount !== 0 || config.syncPipeDesiredState !== 'STOPPED')
  ) {
    throw new Error(
      'applicationActivated=false requires apiDesiredCount=0 and syncPipeDesiredState=STOPPED',
    );
  }
  if (
    environmentName === 'production' &&
    app.node.tryGetContext('confirmProduction') !== 'DEPLOY_PRODUCTION'
  ) {
    throw new Error('production requires -c confirmProduction=DEPLOY_PRODUCTION');
  }
  if (config.deployReady) {
    requiredForDeploy(config, 'account');
  }
  if (config.deployReady && !config.bootstrapOnly) {
    for (const key of [
      'hostedZoneId',
      'hostedZoneName',
      'webDomainName',
      'apiDomainName',
      'certificateArn',
      'alertEmail',
      'nextPublicSupabaseUrl',
      'nextPublicSupabasePublishableKey',
      'supabaseServiceRoleSecretArn',
      'googleClientSecretArn',
      'youtubeApiKeySecretArn',
      'tokenEncryptionKeysSecretArn',
    ] as const) {
      requiredForDeploy(config, key);
    }
    if (environmentName === 'production') requiredForDeploy(config, 'googleClientId');
    validateApplicationSecretArns(config);
    validateProductionIsolation(config);
    if (
      config.githubOwner.startsWith('REQUIRED_') ||
      config.githubRepository.startsWith('REQUIRED_')
    ) {
      throw new Error('CDK deploy requires githubOwner and githubRepository');
    }
    if (config.imageTag === 'bootstrap-required') {
      throw new Error('CDK deploy requires an existing immutable imageTag');
    }
  }

  return config;
};
