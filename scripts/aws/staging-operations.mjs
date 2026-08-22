#!/usr/bin/env node

import { execFile } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { setTimeout as delayFor } from 'node:timers/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_WAKE_HOURS,
  calculateWakeDeadline,
  formatDeadlineJst,
  formatRemaining,
  inspectWakeDeadline,
  parseWakeHours,
} from './staging-auto-sleep/deadline.mjs';
import { schedulerUpdatePayload } from './staging-auto-sleep/sleep-core.mjs';

const execFileAsync = promisify(execFile);

export const STAGING = Object.freeze({
  accountId: '741448960817',
  region: 'ap-northeast-1',
  profile: 'oshi-schedule',
  environment: 'staging',
  stackName: 'oshi-schedule-staging',
});

const waitDefaults = Object.freeze({
  pollMs: 15_000,
  ecsTimeoutMs: 15 * 60_000,
  rdsTimeoutMs: 20 * 60_000,
  readinessTimeoutMs: 10 * 60_000,
  requestTimeoutMs: 10_000,
});

export class AwsCommandError extends Error {
  constructor(message, stderr = '') {
    super(message);
    this.name = 'AwsCommandError';
    this.stderr = stderr;
  }
}

export const createAwsCli = ({ exec = execFileAsync } = {}) => ({
  async json(args, { region = true } = {}) {
    const commandArgs = [...args, '--profile', STAGING.profile];
    if (region) commandArgs.push('--region', STAGING.region);
    commandArgs.push('--output', 'json', '--no-cli-pager');
    try {
      const { stdout } = await exec('aws', commandArgs, {
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return stdout.trim() === '' ? {} : JSON.parse(stdout);
    } catch (error) {
      throw new AwsCommandError(
        `AWS CLI command failed: aws ${args.slice(0, 2).join(' ')}`,
        error.stderr ?? '',
      );
    }
  },
  async text(args, { region = true } = {}) {
    const commandArgs = [...args, '--profile', STAGING.profile];
    if (region) commandArgs.push('--region', STAGING.region);
    commandArgs.push('--output', 'text', '--no-cli-pager');
    try {
      const { stdout } = await exec('aws', commandArgs, {
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      });
      return stdout.trim();
    } catch (error) {
      throw new AwsCommandError(
        `AWS CLI command failed: aws ${args.slice(0, 2).join(' ')}`,
        error.stderr ?? '',
      );
    }
  },
});

const isMissing = (error) =>
  error instanceof AwsCommandError &&
  /not found|does not exist|ValidationError|DBInstanceNotFound|ParameterNotFound|ResourceNotFoundException|NotFoundException|NamespaceNotFound|ServiceNotFound/i.test(
    error.stderr,
  );

export const validateTarget = (target) => {
  if (
    target.profile !== 'oshi-schedule' ||
    target.region !== 'ap-northeast-1' ||
    target.environment !== 'staging' ||
    !target.stackName.endsWith('-staging')
  ) {
    throw new Error('Staging operation constants are unsafe');
  }
};

export const assertStagingGuard = async (aws, target = STAGING) => {
  validateTarget(target);

  const identity = await aws.json(['sts', 'get-caller-identity']);
  if (identity.Account !== target.accountId) {
    throw new Error(`AWS account guard rejected account ${identity.Account ?? 'unknown'}`);
  }
  const configuredRegion = await aws.text(['configure', 'get', 'region'], { region: false });
  if (configuredRegion !== target.region) {
    throw new Error(`AWS region guard rejected region ${configuredRegion || 'unset'}`);
  }
};

const outputMap = (stack) =>
  Object.fromEntries(
    (stack?.Outputs ?? []).map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]),
  );

export const getStack = async (aws) => {
  try {
    const response = await aws.json([
      'cloudformation',
      'describe-stacks',
      '--stack-name',
      STAGING.stackName,
    ]);
    return response.Stacks?.[0];
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

const probe = async (callback) => {
  try {
    return await callback();
  } catch (error) {
    if (isMissing(error)) return { state: 'NOT_DEPLOYED' };
    return { state: 'ERROR', error: error.message };
  }
};

const collectDeadline = async (aws, parameterName, now) => {
  if (!parameterName) return { state: 'NOT_DEPLOYED' };
  try {
    const response = await aws.json(['ssm', 'get-parameter', '--name', parameterName]);
    return inspectWakeDeadline(response.Parameter?.Value, now);
  } catch (error) {
    if (isMissing(error)) return { state: 'UNSET' };
    return { state: 'ERROR', error: error.message };
  }
};

const collectApplicationActivation = async (aws, parameterName) => {
  if (!parameterName) return { state: 'NOT_DEPLOYED' };
  try {
    const response = await aws.json(['ssm', 'get-parameter', '--name', parameterName]);
    if (response.Parameter?.Value === 'true') return { state: 'READY' };
    if (response.Parameter?.Value === 'false') return { state: 'NOT_READY' };
    return { state: 'INVALID' };
  } catch (error) {
    if (isMissing(error)) return { state: 'NOT_DEPLOYED' };
    return { state: 'ERROR', error: error.message };
  }
};

const putDeadline = (aws, parameterName, value) =>
  aws.json([
    'ssm',
    'put-parameter',
    '--name',
    parameterName,
    '--type',
    'String',
    '--value',
    value,
    '--overwrite',
  ]);

export const collectStatus = async (aws, { now = new Date() } = {}) => {
  const stack = await getStack(aws);
  if (!stack) {
    return {
      environment: STAGING.environment,
      overall: 'NOT_DEPLOYED',
      stack: { state: 'NOT_DEPLOYED' },
      api: { state: 'NOT_DEPLOYED' },
      rds: { state: 'NOT_DEPLOYED' },
      scheduler: { state: 'NOT_DEPLOYED' },
      httpApi: { state: 'NOT_DEPLOYED' },
      vpcLink: { state: 'NOT_DEPLOYED' },
      cloudMap: { state: 'NOT_DEPLOYED' },
      syncJobs: { state: 'NOT_DEPLOYED' },
      amplify: { state: 'NOT_DEPLOYED' },
      autoSleep: { state: 'NOT_DEPLOYED' },
      applicationActivation: { state: 'NOT_DEPLOYED' },
    };
  }

  const outputs = outputMap(stack);
  const autoSleep = await collectDeadline(aws, outputs.WakeExpiresAtParameterName, now);
  const applicationActivation = await collectApplicationActivation(
    aws,
    outputs.ApplicationActivationParameterName,
  );
  const fullOutputKeys = [
    'EcsClusterName',
    'ApiServiceName',
    'RdsInstanceIdentifier',
    'WorkerScheduleName',
    'WakeExpiresAtParameterName',
    'ApplicationActivationParameterName',
    'HttpApiId',
    'VpcLinkId',
    'CloudMapNamespaceId',
    'CloudMapServiceId',
    'SyncJobQueueUrl',
    'SyncJobPipeName',
    'AmplifyAppId',
  ];
  const presentFullOutputs = fullOutputKeys.filter((key) => outputs[key]);

  const api =
    outputs.EcsClusterName && outputs.ApiServiceName
      ? await probe(async () => {
          const response = await aws.json([
            'ecs',
            'describe-services',
            '--cluster',
            outputs.EcsClusterName,
            '--services',
            outputs.ApiServiceName,
          ]);
          const service = response.services?.[0];
          if (!service || response.failures?.length) return { state: 'NOT_DEPLOYED' };
          let imageDigest;
          if (service.taskDefinition) {
            const task = await aws.json([
              'ecs',
              'describe-task-definition',
              '--task-definition',
              service.taskDefinition,
            ]);
            const image = task.taskDefinition?.containerDefinitions?.find(
              (container) => container.name === 'api',
            )?.image;
            imageDigest = image?.includes('@sha256:') ? image.split('@')[1] : undefined;
          }
          return {
            state: service.status ?? 'UNKNOWN',
            desiredCount: service.desiredCount ?? 0,
            runningCount: service.runningCount ?? 0,
            pendingCount: service.pendingCount ?? 0,
            rolloutState: service.deployments?.find((deployment) => deployment.status === 'PRIMARY')
              ?.rolloutState,
            imageDigest,
          };
        })
      : { state: 'NOT_DEPLOYED' };

  const rds = outputs.RdsInstanceIdentifier
    ? await probe(async () => {
        const response = await aws.json([
          'rds',
          'describe-db-instances',
          '--db-instance-identifier',
          outputs.RdsInstanceIdentifier,
        ]);
        return { state: response.DBInstances?.[0]?.DBInstanceStatus ?? 'NOT_DEPLOYED' };
      })
    : { state: 'NOT_DEPLOYED' };

  const scheduler = outputs.WorkerScheduleName
    ? await probe(async () => {
        const response = await aws.json([
          'scheduler',
          'get-schedule',
          '--name',
          outputs.WorkerScheduleName,
        ]);
        return { state: response.State ?? 'UNKNOWN' };
      })
    : { state: 'NOT_DEPLOYED' };

  const httpApi = outputs.HttpApiId
    ? await probe(async () => {
        const response = await aws.json(['apigatewayv2', 'get-api', '--api-id', outputs.HttpApiId]);
        return {
          state: response.ApiId && response.ProtocolType === 'HTTP' ? 'DEPLOYED' : 'NOT_DEPLOYED',
        };
      })
    : { state: 'NOT_DEPLOYED' };

  const vpcLink = outputs.VpcLinkId
    ? await probe(async () => {
        const response = await aws.json([
          'apigatewayv2',
          'get-vpc-link',
          '--vpc-link-id',
          outputs.VpcLinkId,
        ]);
        return { state: response.VpcLinkStatus ?? 'NOT_DEPLOYED' };
      })
    : { state: 'NOT_DEPLOYED' };

  const cloudMap =
    outputs.CloudMapNamespaceId && outputs.CloudMapServiceId
      ? await probe(async () => {
          const [namespace, service, instances] = await Promise.all([
            aws.json(['servicediscovery', 'get-namespace', '--id', outputs.CloudMapNamespaceId]),
            aws.json(['servicediscovery', 'get-service', '--id', outputs.CloudMapServiceId]),
            aws.json([
              'servicediscovery',
              'list-instances',
              '--service-id',
              outputs.CloudMapServiceId,
            ]),
          ]);
          return {
            state: namespace.Namespace && service.Service ? 'DEPLOYED' : 'NOT_DEPLOYED',
            registeredInstances: instances.Instances?.length ?? 0,
          };
        })
      : { state: 'NOT_DEPLOYED' };

  const syncJobs =
    outputs.SyncJobQueueUrl && outputs.SyncJobPipeName
      ? await probe(async () => {
          const [queue, pipe] = await Promise.all([
            aws.json([
              'sqs',
              'get-queue-attributes',
              '--queue-url',
              outputs.SyncJobQueueUrl,
              '--attribute-names',
              'ApproximateNumberOfMessages',
              'ApproximateNumberOfMessagesNotVisible',
              'ApproximateNumberOfMessagesDelayed',
            ]),
            aws.json(['pipes', 'describe-pipe', '--name', outputs.SyncJobPipeName]),
          ]);
          return {
            state: pipe.CurrentState ?? 'NOT_DEPLOYED',
            desiredState: pipe.DesiredState ?? 'NOT_DEPLOYED',
            queuedMessages: Number(queue.Attributes?.ApproximateNumberOfMessages ?? 0),
            inFlightMessages: Number(queue.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
            delayedMessages: Number(queue.Attributes?.ApproximateNumberOfMessagesDelayed ?? 0),
          };
        })
      : { state: 'NOT_DEPLOYED' };

  const amplify = outputs.AmplifyAppId
    ? await probe(async () => {
        const response = await aws.json(['amplify', 'get-app', '--app-id', outputs.AmplifyAppId]);
        return { state: response.app ? 'DEPLOYED' : 'NOT_DEPLOYED' };
      })
    : { state: 'NOT_DEPLOYED' };

  const resources = [
    api,
    rds,
    scheduler,
    httpApi,
    vpcLink,
    cloudMap,
    syncJobs,
    amplify,
    applicationActivation,
  ];
  const hasError = resources.some(({ state }) => state === 'ERROR');
  const noneDeployed = presentFullOutputs.length === 0;
  const allOutputsPresent = presentFullOutputs.length === fullOutputKeys.length;
  const sleeping =
    allOutputsPresent &&
    applicationActivation.state === 'READY' &&
    api.desiredCount === 0 &&
    api.runningCount === 0 &&
    api.pendingCount === 0 &&
    rds.state === 'stopped' &&
    scheduler.state === 'DISABLED' &&
    httpApi.state === 'DEPLOYED' &&
    ['AVAILABLE', 'INACTIVE'].includes(vpcLink.state) &&
    cloudMap.state === 'DEPLOYED' &&
    syncJobs.state === 'RUNNING' &&
    amplify.state === 'DEPLOYED';
  const running =
    allOutputsPresent &&
    applicationActivation.state === 'READY' &&
    api.desiredCount === 1 &&
    api.runningCount === 1 &&
    api.pendingCount === 0 &&
    rds.state === 'available' &&
    scheduler.state === 'DISABLED' &&
    httpApi.state === 'DEPLOYED' &&
    vpcLink.state === 'AVAILABLE' &&
    cloudMap.state === 'DEPLOYED' &&
    Number(cloudMap.registeredInstances) >= 1 &&
    syncJobs.state === 'RUNNING' &&
    amplify.state === 'DEPLOYED';
  const notStarted =
    allOutputsPresent &&
    applicationActivation.state === 'NOT_READY' &&
    api.desiredCount === 0 &&
    api.runningCount === 0 &&
    api.pendingCount === 0 &&
    ['available', 'stopped'].includes(rds.state) &&
    scheduler.state === 'DISABLED' &&
    httpApi.state === 'DEPLOYED' &&
    ['AVAILABLE', 'INACTIVE'].includes(vpcLink.state) &&
    cloudMap.state === 'DEPLOYED' &&
    syncJobs.state === 'STOPPED' &&
    amplify.state === 'DEPLOYED';
  const waking =
    ['starting', 'backing-up', 'configuring-enhanced-monitoring', 'modifying'].includes(
      rds.state,
    ) ||
    Number(api.desiredCount) > Number(api.runningCount) ||
    Number(api.pendingCount) > 0 ||
    (api.desiredCount === 1 && ['PENDING', 'INACTIVE', 'UPDATING'].includes(vpcLink.state));

  const overall = hasError
    ? 'ERROR'
    : noneDeployed
      ? 'NOT_DEPLOYED'
      : notStarted
        ? 'NOT_STARTED'
        : sleeping
          ? 'SLEEPING'
          : running
            ? 'RUNNING'
            : waking
              ? 'WAKING'
              : 'PARTIAL';

  return {
    environment: STAGING.environment,
    overall,
    stack: { state: stack.StackStatus ?? 'UNKNOWN' },
    api,
    rds,
    scheduler,
    httpApi,
    vpcLink,
    cloudMap,
    syncJobs,
    amplify,
    autoSleep,
    applicationActivation,
    apiUrl: outputs.ApiUrl,
    webUrl: outputs.WebUrl,
    outputs,
  };
};

export const formatStatus = (status) => {
  const apiState =
    status.api.state === 'NOT_DEPLOYED' || status.api.state === 'ERROR'
      ? status.api.state
      : status.applicationActivation?.state === 'NOT_READY' &&
          status.api.desiredCount === 0 &&
          status.api.runningCount === 0
        ? 'NOT_STARTED'
        : status.api.desiredCount === 0 && status.api.runningCount === 0
          ? 'SLEEPING'
          : status.api.desiredCount === 1 &&
              status.api.runningCount === 1 &&
              status.api.pendingCount === 0
            ? 'RUNNING'
            : Number(status.api.desiredCount) > Number(status.api.runningCount) ||
                Number(status.api.pendingCount) > 0
              ? 'WAKING'
              : 'PARTIAL';
  const lines = [
    `Environment: ${status.environment}`,
    `Status: ${status.overall}`,
    `CloudFormation: ${status.stack.state}`,
    `Application activation: ${status.applicationActivation?.state ?? 'NOT_DEPLOYED'}`,
    `API: ${apiState}`,
  ];
  if (status.api.desiredCount !== undefined) {
    lines.push(`  desiredCount: ${status.api.desiredCount}`);
    lines.push(`  runningCount: ${status.api.runningCount}`);
    lines.push(`  pendingCount: ${status.api.pendingCount}`);
  }
  if (status.api.imageDigest) lines.push(`  imageDigest: ${status.api.imageDigest}`);
  lines.push(`RDS: ${String(status.rds.state).toUpperCase()}`);
  lines.push(`Worker Scheduler: ${status.scheduler.state}`);
  lines.push(`HTTP API: ${String(status.httpApi.state).toUpperCase()}`);
  lines.push(`VPC Link: ${String(status.vpcLink.state).toUpperCase()}`);
  lines.push(`Cloud Map: ${String(status.cloudMap.state).toUpperCase()}`);
  if (status.cloudMap.registeredInstances !== undefined)
    lines.push(`  registeredInstances: ${status.cloudMap.registeredInstances}`);
  lines.push(`Sync jobs: ${String(status.syncJobs.state).toUpperCase()}`);
  if (status.syncJobs.queuedMessages !== undefined)
    lines.push(`  queuedMessages: ${status.syncJobs.queuedMessages}`);
  lines.push(`Amplify: ${status.amplify.state}`);
  if (status.apiUrl) lines.push(`API URL: ${status.apiUrl}`);
  if (status.webUrl) lines.push(`Web URL: ${status.webUrl}`);
  lines.push('Auto sleep:');
  if (status.autoSleep?.expiresAt) {
    lines.push(`  Expires at: ${formatDeadlineJst(status.autoSleep.expiresAt)}`);
  }
  if (status.autoSleep?.state === 'ACTIVE') {
    lines.push(`  Remaining: ${formatRemaining(status.autoSleep.remainingMs)}`);
  } else if (status.autoSleep?.state === 'EXPIRED') {
    lines.push('  Deadline expired');
  } else if (status.autoSleep?.state === 'INVALID') {
    lines.push('  Invalid deadline');
  } else if (status.autoSleep?.state === 'ERROR') {
    lines.push('  Status unavailable');
  } else if (status.autoSleep?.state === 'NOT_DEPLOYED') {
    lines.push('  Not deployed');
  } else {
    lines.push('  Deadline not set');
  }
  return lines.join('\n');
};

const waitUntil = async ({ label, check, timeoutMs, pollMs, delay }) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  do {
    last = await check();
    if (last.done) return last.value;
    if (Date.now() >= deadline) break;
    await delay(pollMs);
  } while (Date.now() < deadline);
  throw new Error(`${label} timed out${last?.detail ? ` (${last.detail})` : ''}`);
};

const ensureSchedulerDisabled = async (aws, name) => {
  if (!name) return 'NOT_DEPLOYED';
  let schedule;
  try {
    schedule = await aws.json(['scheduler', 'get-schedule', '--name', name]);
  } catch (error) {
    if (isMissing(error)) return 'NOT_DEPLOYED';
    throw error;
  }
  if (schedule.State === 'DISABLED') return 'DISABLED';
  await aws.json([
    'scheduler',
    'update-schedule',
    '--cli-input-json',
    JSON.stringify(schedulerUpdatePayload(schedule, 'DISABLED')),
  ]);
  return 'DISABLED';
};

const describeApi = async (aws, outputs) => {
  const response = await aws.json([
    'ecs',
    'describe-services',
    '--cluster',
    outputs.EcsClusterName,
    '--services',
    outputs.ApiServiceName,
  ]);
  const service = response.services?.[0];
  if (!service || response.failures?.length) throw new Error('ECS API service is not deployed');
  return service;
};

const describeRds = async (aws, identifier) => {
  const response = await aws.json([
    'rds',
    'describe-db-instances',
    '--db-instance-identifier',
    identifier,
  ]);
  const instance = response.DBInstances?.[0];
  if (!instance) throw new Error('RDS instance is not deployed');
  return instance;
};

const waitForRds = (aws, identifier, expected, options) =>
  waitUntil({
    label: `RDS ${expected}`,
    timeoutMs: options.rdsTimeoutMs,
    pollMs: options.pollMs,
    delay: options.delay,
    check: async () => {
      const instance = await describeRds(aws, identifier);
      return {
        done: instance.DBInstanceStatus === expected,
        value: instance,
        detail: instance.DBInstanceStatus,
      };
    },
  });

const waitForApi = (aws, outputs, expectedDesired, options) =>
  waitUntil({
    label: `ECS desiredCount=${expectedDesired}`,
    timeoutMs: options.ecsTimeoutMs,
    pollMs: options.pollMs,
    delay: options.delay,
    check: async () => {
      const service = await describeApi(aws, outputs);
      const stopped = expectedDesired === 0;
      const primary = service.deployments?.find((deployment) => deployment.status === 'PRIMARY');
      const stable =
        service.desiredCount === expectedDesired &&
        service.runningCount === expectedDesired &&
        service.pendingCount === 0 &&
        (stopped || !primary?.rolloutState || primary.rolloutState === 'COMPLETED');
      return {
        done: stable,
        value: service,
        detail: `desired=${service.desiredCount}, running=${service.runningCount}, pending=${service.pendingCount}`,
      };
    },
  });

const ensureRdsAvailable = async (aws, identifier, options) => {
  let instance = await describeRds(aws, identifier);
  if (instance.DBInstanceStatus === 'stopping') {
    instance = await waitForRds(aws, identifier, 'stopped', options);
  }
  if (instance.DBInstanceStatus === 'stopped') {
    await aws.json(['rds', 'start-db-instance', '--db-instance-identifier', identifier]);
    return waitForRds(aws, identifier, 'available', options);
  }
  if (instance.DBInstanceStatus === 'available') return instance;
  if (['starting', 'backing-up', 'modifying'].includes(instance.DBInstanceStatus)) {
    return waitForRds(aws, identifier, 'available', options);
  }
  throw new Error(`RDS cannot be started safely from state ${instance.DBInstanceStatus}`);
};

const ensureRdsStopped = async (aws, identifier, options) => {
  let instance = await describeRds(aws, identifier);
  if (instance.DBInstanceStatus === 'stopped') return instance;
  if (instance.DBInstanceStatus === 'stopping') {
    return waitForRds(aws, identifier, 'stopped', options);
  }
  if (['starting', 'backing-up', 'modifying'].includes(instance.DBInstanceStatus)) {
    instance = await waitForRds(aws, identifier, 'available', options);
  }
  if (instance.DBInstanceStatus !== 'available') {
    throw new Error(`RDS cannot be stopped safely from state ${instance.DBInstanceStatus}`);
  }
  await aws.json(['rds', 'stop-db-instance', '--db-instance-identifier', identifier]);
  return waitForRds(aws, identifier, 'stopped', options);
};

const requireFullDeployment = (status) => {
  const required = [
    'EcsClusterName',
    'ApiServiceName',
    'RdsInstanceIdentifier',
    'WorkerScheduleName',
    'WakeExpiresAtParameterName',
    'ApplicationActivationParameterName',
  ];
  if (!status.outputs || required.some((key) => !status.outputs[key])) {
    throw new Error('Staging full stack is NOT_DEPLOYED; no write was attempted');
  }
  if (status.outputs.EnvironmentName !== STAGING.environment) {
    throw new Error('CloudFormation environment guard rejected this stack; no write was attempted');
  }
  if (!/^(CREATE|UPDATE|IMPORT|UPDATE_ROLLBACK)_COMPLETE$/.test(status.stack.state)) {
    throw new Error(
      `CloudFormation stack is not stable (${status.stack.state}); no write was attempted`,
    );
  }
  if (status.overall === 'ERROR') {
    throw new Error('Current staging state contains read errors; no write was attempted');
  }
};

const checkEndpoint = async (fetchImpl, url, requestTimeoutMs) => {
  try {
    const response = await fetchImpl(url, {
      redirect: 'follow',
      // AbortSignal.timeout is available in the required Node.js 22 runtime.
      // eslint-disable-next-line no-undef
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
};

const waitForReadiness = async (fetchImpl, apiUrl, options) => {
  if (!apiUrl) throw new Error('ApiUrl CloudFormation output is missing');
  const base = apiUrl.replace(/\/$/, '');
  return waitUntil({
    label: 'API readiness',
    timeoutMs: options.readinessTimeoutMs,
    pollMs: options.pollMs,
    delay: options.delay,
    check: async () => {
      const health = await checkEndpoint(fetchImpl, `${base}/health`, options.requestTimeoutMs);
      const ready =
        health && (await checkEndpoint(fetchImpl, `${base}/ready`, options.requestTimeoutMs));
      return {
        done: health && ready,
        value: { health, ready },
        detail: `health=${health}, ready=${ready}`,
      };
    },
  });
};

const optionsFor = (options = {}) => ({
  ...waitDefaults,
  delay: delayFor,
  fetchImpl: globalThis.fetch,
  now: () => new Date(),
  ...options,
});

export const sleepStaging = async (aws, options = {}) => {
  const runtime = optionsFor(options);
  const before = await collectStatus(aws);
  requireFullDeployment(before);
  const outputs = before.outputs;

  await putDeadline(aws, outputs.WakeExpiresAtParameterName, runtime.now().toISOString());
  await ensureSchedulerDisabled(aws, outputs.WorkerScheduleName);
  const service = await describeApi(aws, outputs);
  if (service.desiredCount !== 0) {
    await aws.json([
      'ecs',
      'update-service',
      '--cluster',
      outputs.EcsClusterName,
      '--service',
      outputs.ApiServiceName,
      '--desired-count',
      '0',
    ]);
  }
  await waitForApi(aws, outputs, 0, runtime);
  await ensureRdsStopped(aws, outputs.RdsInstanceIdentifier, runtime);
  return collectStatus(aws, { now: runtime.now() });
};

export const wakeStaging = async (aws, options = {}) => {
  const runtime = optionsFor(options);
  const before = await collectStatus(aws);
  requireFullDeployment(before);
  if (before.applicationActivation?.state !== 'READY') {
    throw new Error(
      'Staging application is not activated yet. Complete migration and Phase 2 deployment first. No write was attempted.',
    );
  }
  const outputs = before.outputs;

  const expiresAt = calculateWakeDeadline(options.hours ?? DEFAULT_WAKE_HOURS, runtime.now());
  await putDeadline(aws, outputs.WakeExpiresAtParameterName, expiresAt);
  await ensureSchedulerDisabled(aws, outputs.WorkerScheduleName);
  await ensureRdsAvailable(aws, outputs.RdsInstanceIdentifier, runtime);
  const service = await describeApi(aws, outputs);
  if (service.desiredCount !== 1) {
    await aws.json([
      'ecs',
      'update-service',
      '--cluster',
      outputs.EcsClusterName,
      '--service',
      outputs.ApiServiceName,
      '--desired-count',
      '1',
    ]);
  }
  await waitForApi(aws, outputs, 1, runtime);
  await waitForReadiness(runtime.fetchImpl, outputs.ApiUrl, runtime);
  return collectStatus(aws, { now: runtime.now() });
};

export const parseCommandArguments = (command, args = []) => {
  if (command === 'wake') return { hours: parseWakeHours(args) };
  if (args.length > 0) throw new Error(`staging:${command} does not accept arguments`);
  return {};
};

export const runCommand = async (
  command,
  { aws = createAwsCli(), log = console.log, ...options } = {},
  args = [],
) => {
  if (!['status', 'sleep', 'wake'].includes(command)) {
    throw new Error('Usage: staging-operations.mjs <status|sleep|wake>');
  }
  const commandOptions = parseCommandArguments(command, args);
  await assertStagingGuard(aws);
  try {
    const status =
      command === 'status'
        ? await collectStatus(aws)
        : command === 'sleep'
          ? await sleepStaging(aws, options)
          : await wakeStaging(aws, { ...options, ...commandOptions });
    log(formatStatus(status));
    if (['ERROR', 'PARTIAL', 'WAKING'].includes(status.overall)) process.exitCode = 1;
    if (command === 'status' && ['ERROR', 'INVALID'].includes(status.autoSleep?.state)) {
      process.exitCode = 1;
    }
    return status;
  } catch (error) {
    error.stagingGuardPassed = true;
    throw error;
  }
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const aws = createAwsCli();
  runCommand(process.argv[2], { aws }, process.argv.slice(3)).catch(async (error) => {
    console.error(`Operation failed: ${error.message}`);
    if (error.stagingGuardPassed) {
      try {
        const status = await collectStatus(aws);
        console.error(formatStatus(status));
      } catch {
        // The status lookup failed; do not print raw AWS responses.
      }
    }
    process.exitCode = 1;
  });
}
