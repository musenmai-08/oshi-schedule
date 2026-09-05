#!/usr/bin/env node

import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const profile = 'oshi-schedule';
const region = 'ap-northeast-1';
const stackName = 'oshi-schedule-staging-serverless';

const aws = async (args) => {
  const { stdout } = await exec('aws', [...args, '--profile', profile, '--region', region, '--output', 'json', '--no-cli-pager']);
  return JSON.parse(stdout);
};

const queueCounts = async (command, url) => {
  const value = await command(['sqs', 'get-queue-attributes', '--queue-url', url, '--attribute-names', 'ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible']);
  return { visible: Number(value.Attributes?.ApproximateNumberOfMessages ?? 0), inFlight: Number(value.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0) };
};

export const collectServerlessStatus = async ({ command = aws, fetchImpl = globalThis.fetch } = {}) => {
  const stack = (await command(['cloudformation', 'describe-stacks', '--stack-name', stackName])).Stacks?.[0];
  if (!stack) throw new Error('serverless staging stack is not deployed');
  const outputs = Object.fromEntries((stack.Outputs ?? []).map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]));
  const [api, worker, mapping, scheduler, sync, dlq, alarms] = await Promise.all([
    command(['lambda', 'get-function-configuration', '--function-name', outputs.ApiFunctionName]),
    command(['lambda', 'get-function-configuration', '--function-name', outputs.WorkerFunctionName]),
    command(['lambda', 'list-event-source-mappings', '--function-name', outputs.WorkerFunctionName]),
    command(['scheduler', 'get-schedule', '--name', outputs.WorkerScheduleName, '--group-name', 'default']),
    queueCounts(command, outputs.SyncJobQueueUrl),
    queueCounts(command, `https://sqs.${region}.amazonaws.com/741448960817/oshi-schedule-staging-serverless-sync-jobs-dlq`),
    command(['cloudwatch', 'describe-alarms', '--alarm-name-prefix', 'oshi-schedule-staging-serverless']),
  ]);
  const endpoint = (await command(['apigatewayv2', 'get-api', '--api-id', outputs.HttpApiId])).ApiEndpoint;
  const ready = await fetchImpl(`${endpoint}/ready`).then((response) => response.ok).catch(() => false);
  return { stack: stack.StackStatus, api: api.State, worker: worker.State, ready, scheduler: scheduler.State, queue: sync, dlq, mapping: mapping.EventSourceMappings?.[0] ? { state: mapping.EventSourceMappings[0].State, batchSize: mapping.EventSourceMappings[0].BatchSize, maximumConcurrency: mapping.EventSourceMappings[0].ScalingConfig?.MaximumConcurrency } : null, alarms: (alarms.MetricAlarms ?? []).map(({ AlarmName, StateValue }) => ({ name: AlarmName, state: StateValue })) };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  collectServerlessStatus().then((value) => process.stdout.write(`${JSON.stringify(value)}\n`)).catch(() => { process.stderr.write('Serverless staging status unavailable\n'); process.exitCode = 1; });
}
