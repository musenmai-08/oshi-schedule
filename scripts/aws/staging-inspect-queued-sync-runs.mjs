#!/usr/bin/env node

import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { assertStagingGuard, createAwsCli, STAGING } from './staging-operations.mjs';

const terminalStackStatuses = new Set([
  'CREATE_COMPLETE',
  'IMPORT_COMPLETE',
  'UPDATE_COMPLETE',
  'UPDATE_ROLLBACK_COMPLETE',
]);

const safeCandidate = (value) =>
  value &&
  typeof value.id === 'string' &&
  value.status === 'QUEUED' &&
  (value.trigger === 'INITIAL' || value.trigger === 'MANUAL') &&
  typeof value.queuedAt === 'string' &&
  Number.isFinite(Date.parse(value.queuedAt));

export const parseInspectionArguments = (args = []) => {
  if (args.length === 0) return { execute: false };
  if (args.length === 1 && args[0] === '--execute') return { execute: true };
  throw new Error('Usage: staging:inspect-queued-sync-runs [--execute]');
};

export const buildInspectionOverride = () =>
  JSON.stringify({
    containerOverrides: [
      { name: 'worker', command: ['node', 'worker/dist/inspect-queued-sync-runs.js'] },
    ],
  });

export const parseInspectionLogMessages = (messages) => {
  const candidates = messages
    .map((message) => {
      try {
        return JSON.parse(message);
      } catch {
        return undefined;
      }
    })
    .filter(
      (value) =>
        value?.level === 'info' &&
        value.event === 'queued_sync_run_inspection' &&
        value.mode === 'READ_ONLY',
    );
  if (candidates.length !== 1) throw new Error('Inspection task did not emit one valid result');

  const result = candidates[0];
  if (
    !['NONE', 'EXACTLY_ONE', 'MULTIPLE'].includes(result.selection) ||
    !Number.isSafeInteger(result.candidateCount) ||
    result.candidateCount < 0 ||
    !Array.isArray(result.candidates) ||
    !result.candidates.every(safeCandidate) ||
    typeof result.candidatesTruncated !== 'boolean'
  ) {
    throw new Error('Inspection task emitted an unsafe result');
  }
  return {
    level: 'info',
    event: 'queued_sync_run_inspection',
    mode: 'READ_ONLY',
    selection: result.selection,
    candidateCount: result.candidateCount,
    candidates: result.candidates.map(({ id, status, trigger, queuedAt }) => ({
      id,
      status,
      trigger,
      queuedAt,
    })),
    candidatesTruncated: result.candidatesTruncated,
  };
};

const outputMap = (stack) =>
  Object.fromEntries(
    (stack?.Outputs ?? []).map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]),
  );

export const getInspectionPlan = async (aws) => {
  await assertStagingGuard(aws);
  const stackResponse = await aws.json([
    'cloudformation',
    'describe-stacks',
    '--stack-name',
    STAGING.stackName,
  ]);
  const stack = stackResponse.Stacks?.[0];
  if (!stack || !terminalStackStatuses.has(stack.StackStatus))
    throw new Error('Staging CloudFormation stack is not terminal');
  const outputs = outputMap(stack);
  const workerTaskDefinition = outputs.WorkerTaskDefinitionArn;
  const cluster = outputs.EcsClusterName;
  const pipeName = outputs.SyncJobPipeName;
  if (!workerTaskDefinition || !cluster || !pipeName)
    throw new Error('Staging worker outputs are missing');

  const [pipe, taskDefinition] = await Promise.all([
    aws.json(['pipes', 'describe-pipe', '--name', pipeName]),
    aws.json(['ecs', 'describe-task-definition', '--task-definition', workerTaskDefinition]),
  ]);
  const network =
    pipe.TargetParameters?.EcsTaskParameters?.NetworkConfiguration?.awsvpcConfiguration;
  const worker = taskDefinition.taskDefinition?.containerDefinitions?.find(
    (container) => container.name === 'worker',
  );
  const logOptions = worker?.logConfiguration?.options ?? {};
  if (
    !Array.isArray(network?.Subnets) ||
    network.Subnets.length === 0 ||
    !Array.isArray(network?.SecurityGroups) ||
    network.SecurityGroups.length === 0 ||
    network.AssignPublicIp !== 'ENABLED' ||
    worker?.name !== 'worker' ||
    typeof logOptions['awslogs-group'] !== 'string' ||
    typeof logOptions['awslogs-stream-prefix'] !== 'string'
  ) {
    throw new Error('Deployed Worker task configuration is unsafe for inspection');
  }
  return {
    cluster,
    workerTaskDefinition,
    network,
    logGroup: logOptions['awslogs-group'],
    logStreamPrefix: logOptions['awslogs-stream-prefix'],
  };
};

const taskIdFromArn = (taskArn) => taskArn.split('/').at(-1);

const runInspectionTask = async (aws, plan) => {
  const networkConfiguration = {
    awsvpcConfiguration: {
      subnets: plan.network.Subnets,
      securityGroups: plan.network.SecurityGroups,
      assignPublicIp: plan.network.AssignPublicIp,
    },
  };
  const result = await aws.json([
    'ecs',
    'run-task',
    '--cluster',
    plan.cluster,
    '--task-definition',
    plan.workerTaskDefinition,
    '--launch-type',
    'FARGATE',
    '--platform-version',
    'LATEST',
    '--count',
    '1',
    '--started-by',
    'oshi-read-only-sync-run-inspection',
    '--network-configuration',
    JSON.stringify(networkConfiguration),
    '--overrides',
    buildInspectionOverride(),
  ]);
  const taskArn = result.tasks?.[0]?.taskArn;
  if (!taskArn || result.failures?.length) throw new Error('Inspection task could not be started');
  return taskArn;
};

const waitForStoppedTask = async (aws, cluster, taskArn) => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await aws.json([
      'ecs',
      'describe-tasks',
      '--cluster',
      cluster,
      '--tasks',
      taskArn,
    ]);
    const task = response.tasks?.[0];
    if (task?.lastStatus === 'STOPPED') return task;
    await delay(5_000);
  }
  throw new Error('Inspection task did not stop before timeout');
};

const readInspectionResult = async (aws, plan, task) => {
  const taskId = taskIdFromArn(task.taskArn);
  const logStream =
    task.containers?.find((container) => container.name === 'worker')?.logStreamName ??
    `${plan.logStreamPrefix}/worker/${taskId}`;
  const logs = await aws.json([
    'logs',
    'get-log-events',
    '--log-group-name',
    plan.logGroup,
    '--log-stream-name',
    logStream,
    '--start-from-head',
  ]);
  const exitCode = task.containers?.find((container) => container.name === 'worker')?.exitCode;
  if (exitCode !== 0) throw new Error('Inspection task exited unsuccessfully');
  return parseInspectionLogMessages((logs.events ?? []).map(({ message }) => message));
};

export const inspectQueuedSyncRuns = async (aws, { execute }) => {
  const plan = await getInspectionPlan(aws);
  if (!execute) {
    return {
      level: 'info',
      event: 'queued_sync_run_inspection_dry_run',
      mode: 'READ_ONLY',
      taskExecutionRequired: true,
      workerTaskDefinition: plan.workerTaskDefinition,
    };
  }
  const taskArn = await runInspectionTask(aws, plan);
  const task = await waitForStoppedTask(aws, plan.cluster, taskArn);
  return readInspectionResult(aws, plan, task);
};

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    const result = await inspectQueuedSyncRuns(
      createAwsCli(),
      parseInspectionArguments(process.argv.slice(2)),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write('Queued SyncRun inspection failed safely\n');
    process.exitCode = 1;
  }
}
