import type { App } from 'aws-cdk-lib';

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
    validateApplicationSecretArns(config);
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
