import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildInspectionOverride,
  parseInspectionArguments,
  parseInspectionLogMessages,
  parseStateInspectionLogMessages,
  runInspectionTask,
} from './staging-inspect-queued-sync-runs.mjs';

test('inspection command requires an explicit execute opt-in', () => {
  assert.deepEqual(parseInspectionArguments(), { execute: false });
  assert.deepEqual(parseInspectionArguments(['--execute']), { execute: true });
  assert.deepEqual(parseInspectionArguments(['--states']), { execute: false, mode: 'states' });
  assert.deepEqual(parseInspectionArguments(['--states', '--execute']), {
    execute: true,
    mode: 'states',
  });
  assert.throws(() => parseInspectionArguments(['--worker-command=unsafe']));
});

test('inspection override is fixed to the read-only Worker entry point', () => {
  assert.deepEqual(JSON.parse(buildInspectionOverride()), {
    containerOverrides: [
      { name: 'worker', command: ['node', 'worker/dist/inspect-queued-sync-runs.js'] },
    ],
  });
});

test('state inspection override is fixed to its read-only Worker entry point', () => {
  assert.deepEqual(JSON.parse(buildInspectionOverride('states')), {
    containerOverrides: [
      { name: 'worker', command: ['node', 'worker/dist/inspect-sync-run-states.js'] },
    ],
  });
});

test('execute passes state mode through to the ECS override', async () => {
  const calls = [];
  const aws = {
    json: async (args) => {
      calls.push(args);
      return { tasks: [{ taskArn: 'arn:aws:ecs:region:account:task/cluster/task-id' }] };
    },
  };
  await runInspectionTask(
    aws,
    {
      cluster: 'cluster',
      workerTaskDefinition: 'worker:1',
      network: { Subnets: ['subnet'], SecurityGroups: ['sg'], AssignPublicIp: 'ENABLED' },
    },
    'states',
  );
  assert.deepEqual(JSON.parse(calls[0][calls[0].indexOf('--overrides') + 1]), {
    containerOverrides: [
      { name: 'worker', command: ['node', 'worker/dist/inspect-sync-run-states.js'] },
    ],
  });
});

test('execute keeps the queued inspector override by default', async () => {
  const calls = [];
  const aws = {
    json: async (args) => {
      calls.push(args);
      return { tasks: [{ taskArn: 'arn:aws:ecs:region:account:task/cluster/task-id' }] };
    },
  };
  await runInspectionTask(aws, {
    cluster: 'cluster',
    workerTaskDefinition: 'worker:1',
    network: { Subnets: ['subnet'], SecurityGroups: ['sg'], AssignPublicIp: 'ENABLED' },
  });
  assert.deepEqual(JSON.parse(calls[0][calls[0].indexOf('--overrides') + 1]), {
    containerOverrides: [
      { name: 'worker', command: ['node', 'worker/dist/inspect-queued-sync-runs.js'] },
    ],
  });
});

test('state inspection output returns only safe state fields', () => {
  const at = '2026-08-30T00:00:00.000Z';
  assert.deepEqual(
    parseStateInspectionLogMessages([
      JSON.stringify({
        level: 'info',
        event: 'sync_run_state_inspection',
        mode: 'READ_ONLY',
        runCount: 1,
        runs: [
          {
            id: 'safe-run-id',
            status: 'FAILED',
            trigger: 'MANUAL',
            queuedAt: at,
            startedAt: at,
            completedAt: at,
            errorCode: 'SYNC_FAILED',
            email: 'must-not-be-returned',
          },
        ],
        runsTruncated: false,
      }),
    ]),
    {
      level: 'info',
      event: 'sync_run_state_inspection',
      mode: 'READ_ONLY',
      runCount: 1,
      runs: [
        {
          id: 'safe-run-id',
          status: 'FAILED',
          trigger: 'MANUAL',
          queuedAt: at,
          startedAt: at,
          completedAt: at,
          errorCode: 'SYNC_FAILED',
        },
      ],
      runsTruncated: false,
    },
  );
});

test('inspection output accepts only the safe candidate shape', () => {
  const result = parseInspectionLogMessages([
    'not-json',
    JSON.stringify({
      level: 'info',
      event: 'queued_sync_run_inspection',
      mode: 'READ_ONLY',
      selection: 'EXACTLY_ONE',
      candidateCount: 1,
      candidates: [
        {
          id: 'safe-run-id',
          status: 'QUEUED',
          trigger: 'MANUAL',
          queuedAt: '2026-08-29T00:00:00.000Z',
          email: 'must-not-be-returned',
        },
      ],
      candidatesTruncated: false,
    }),
  ]);
  assert.deepEqual(result, {
    level: 'info',
    event: 'queued_sync_run_inspection',
    mode: 'READ_ONLY',
    selection: 'EXACTLY_ONE',
    candidateCount: 1,
    candidates: [
      {
        id: 'safe-run-id',
        status: 'QUEUED',
        trigger: 'MANUAL',
        queuedAt: '2026-08-29T00:00:00.000Z',
      },
    ],
    candidatesTruncated: false,
  });
});

test('inspection output rejects malformed or ambiguous log records', () => {
  assert.throws(() => parseInspectionLogMessages([]));
  assert.throws(() =>
    parseInspectionLogMessages([
      JSON.stringify({
        level: 'info',
        event: 'queued_sync_run_inspection',
        mode: 'READ_ONLY',
        selection: 'EXACTLY_ONE',
        candidateCount: 1,
        candidates: [{ id: 'unsafe', status: 'SUCCESS', trigger: 'MANUAL', queuedAt: 'invalid' }],
        candidatesTruncated: false,
      }),
    ]),
  );
});
