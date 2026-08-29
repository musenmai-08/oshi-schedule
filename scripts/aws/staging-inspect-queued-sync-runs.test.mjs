import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildInspectionOverride,
  parseInspectionArguments,
  parseInspectionLogMessages,
} from './staging-inspect-queued-sync-runs.mjs';

test('inspection command requires an explicit execute opt-in', () => {
  assert.deepEqual(parseInspectionArguments(), { execute: false });
  assert.deepEqual(parseInspectionArguments(['--execute']), { execute: true });
  assert.throws(() => parseInspectionArguments(['--worker-command=unsafe']));
});

test('inspection override is fixed to the read-only Worker entry point', () => {
  assert.deepEqual(JSON.parse(buildInspectionOverride()), {
    containerOverrides: [
      { name: 'worker', command: ['node', 'worker/dist/inspect-queued-sync-runs.js'] },
    ],
  });
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
