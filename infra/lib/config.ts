import type { App } from 'aws-cdk-lib';

export type EnvironmentName = 'staging' | 'production';

export interface DeploymentConfig {
  environmentName: EnvironmentName;
  account?: string;
  region: string;
  deployReady: boolean;
  hostedZoneId?: string;
  hostedZoneName?: string;
  webDomainName?: string;
  apiDomainName?: string;
  certificateArn?: string;
  alertEmail?: string;
  nextPublicSupabaseUrl?: string;
  nextPublicSupabasePublishableKey?: string;
  monthlyBudgetUsd: number;
  githubOwner: string;
  githubRepository: string;
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

const requiredForDeploy = (config: DeploymentConfig, name: keyof DeploymentConfig): void => {
  if (config[name] === undefined || config[name] === '') {
    throw new Error(`CDK deploy requires context: ${String(name)}`);
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
    deployReady: app.node.tryGetContext('deployReady') === true,
    hostedZoneId: optionalString(app, 'hostedZoneId'),
    hostedZoneName: optionalString(app, 'hostedZoneName'),
    webDomainName: optionalString(app, 'webDomainName'),
    apiDomainName: optionalString(app, 'apiDomainName'),
    certificateArn: optionalString(app, 'certificateArn'),
    alertEmail: optionalString(app, 'alertEmail'),
    nextPublicSupabaseUrl: optionalString(app, 'nextPublicSupabaseUrl'),
    nextPublicSupabasePublishableKey: optionalString(app, 'nextPublicSupabasePublishableKey'),
    monthlyBudgetUsd: Number(app.node.tryGetContext('monthlyBudgetUsd') ?? 75),
    githubOwner: optionalString(app, 'githubOwner') ?? 'REQUIRED_GITHUB_OWNER',
    githubRepository: optionalString(app, 'githubRepository') ?? 'REQUIRED_GITHUB_REPOSITORY',
    imageTag: optionalString(app, 'imageTag') ?? 'bootstrap-required',
    apiCpu: Number(app.node.tryGetContext('apiCpu') ?? 256),
    apiMemoryMiB: Number(app.node.tryGetContext('apiMemoryMiB') ?? 512),
    workerCpu: Number(app.node.tryGetContext('workerCpu') ?? 256),
    workerMemoryMiB: Number(app.node.tryGetContext('workerMemoryMiB') ?? 512),
    rdsInstanceType: optionalString(app, 'rdsInstanceType') ?? 't4g.micro',
    rdsAllocatedStorageGiB: Number(app.node.tryGetContext('rdsAllocatedStorageGiB') ?? 20),
    rdsBackupRetentionDays: Number(app.node.tryGetContext('rdsBackupRetentionDays') ?? 1),
    rdsMultiAz: app.node.tryGetContext('rdsMultiAz') === true,
    rdsDeletionProtection: app.node.tryGetContext('rdsDeletionProtection') !== false,
    workerScheduleEnabled: app.node.tryGetContext('workerScheduleEnabled') === true,
  };

  if (!Number.isFinite(config.monthlyBudgetUsd) || config.monthlyBudgetUsd <= 0) {
    throw new Error('monthlyBudgetUsd must be a positive number');
  }
  if (environmentName === 'production' && app.node.tryGetContext('confirmProduction') !== 'DEPLOY_PRODUCTION') {
    throw new Error('production requires -c confirmProduction=DEPLOY_PRODUCTION');
  }
  if (config.deployReady) {
    for (const key of [
      'account',
      'hostedZoneId',
      'hostedZoneName',
      'webDomainName',
      'apiDomainName',
      'certificateArn',
      'alertEmail',
      'nextPublicSupabaseUrl',
      'nextPublicSupabasePublishableKey',
    ] as const) {
      requiredForDeploy(config, key);
    }
    if (config.githubOwner.startsWith('REQUIRED_') || config.githubRepository.startsWith('REQUIRED_')) {
      throw new Error('CDK deploy requires githubOwner and githubRepository');
    }
    if (config.imageTag === 'bootstrap-required') {
      throw new Error('CDK deploy requires an existing immutable imageTag');
    }
  }

  return config;
};
