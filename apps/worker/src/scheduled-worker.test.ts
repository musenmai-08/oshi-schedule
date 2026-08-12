import { describe, expect, it, vi } from 'vitest';
import {
  executeScheduledWorker,
  executeScheduledWorkerLifecycle,
  formatScheduledWorkerLog,
  selectWorkerExecution,
  summarizeScheduledResults,
} from './scheduled-worker.js';

describe('scheduled worker outcome', () => {
  it('selects exactly one targeted sync when SYNC_RUN_ID is present', async () => {
    const runScheduled = vi.fn(async () => [{ status: 'SUCCESS' }]);
    const runTargeted = vi.fn(async () => ({ status: 'SUCCESS' }));
    const result = await selectWorkerExecution('  run-id  ', runScheduled, runTargeted)();
    expect(result).toEqual([{ status: 'SUCCESS' }]);
    expect(runTargeted).toHaveBeenCalledWith('run-id');
    expect(runScheduled).not.toHaveBeenCalled();
  });

  it('retains scheduled mode when no targeted ID is provided', async () => {
    const runScheduled = vi.fn(async () => [{ status: 'SUCCESS' }]);
    const runTargeted = vi.fn(async () => ({ status: 'SUCCESS' }));
    await selectWorkerExecution(' ', runScheduled, runTargeted)();
    expect(runScheduled).toHaveBeenCalledOnce();
    expect(runTargeted).not.toHaveBeenCalled();
  });

  it.each([
    ['all success', ['SUCCESS', 'SUCCESS'], 0],
    ['with skipped', ['SUCCESS', 'SKIPPED'], 0],
    ['with deferred', ['SUCCESS', 'DEFERRED'], 0],
    ['no targets', [], 0],
    ['partial failure', ['SUCCESS', 'FAILED'], 1],
    ['all failed', ['FAILED', 'FAILED'], 1],
  ] as const)('%s returns exit %i', async (_name, statuses, expectedExit) => {
    const outcome = await executeScheduledWorker(async () =>
      statuses.map((status) => ({ status, subscriptionId: 'must-not-be-logged' })),
    );
    expect(outcome.exitCode).toBe(expectedExit);
  });

  it('returns exit 1 for an unhandled worker exception without exposing it', async () => {
    const outcome = await executeScheduledWorker(async () => {
      throw new Error('database-url-and-user-details');
    });
    expect(outcome).toEqual({
      exitCode: 1,
      summary: { total: 0, success: 0, skipped: 0, deferred: 0, failed: 0 },
      errorCode: 'WORKER_UNHANDLED_ERROR',
    });
    expect(formatScheduledWorkerLog(outcome)).not.toContain('database-url-and-user-details');
  });

  it('counts every terminal state and logs only the aggregate', () => {
    const summary = summarizeScheduledResults([
      { status: 'SUCCESS' },
      { status: 'SKIPPED' },
      { status: 'DEFERRED' },
      { status: 'FAILED' },
    ]);
    expect(summary).toEqual({ total: 4, success: 1, skipped: 1, deferred: 1, failed: 1 });
    const line = formatScheduledWorkerLog({ exitCode: 1, summary });
    expect(JSON.parse(line)).toEqual({
      level: 'error',
      event: 'scheduled_sync_completed',
      total: 4,
      success: 1,
      skipped: 1,
      deferred: 1,
      failed: 1,
    });
    expect(line).not.toMatch(/subscription|user|email|calendar|token/i);
  });

  it('treats an unknown target status as failed', async () => {
    const outcome = await executeScheduledWorker(async () => [{ status: 'UNKNOWN' }]);
    expect(outcome).toMatchObject({ exitCode: 1, summary: { total: 1, failed: 1 } });
  });

  it.each([
    ['SUCCESS', 0],
    ['FAILED', 1],
  ] as const)('disconnects after a %s result', async (status, exitCode) => {
    const disconnect = vi.fn(async () => undefined);
    const outcome = await executeScheduledWorkerLifecycle(async () => [{ status }], disconnect);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(outcome.exitCode).toBe(exitCode);
  });

  it('disconnects after an unhandled worker exception', async () => {
    const disconnect = vi.fn(async () => undefined);
    const outcome = await executeScheduledWorkerLifecycle(async () => {
      throw new Error('worker failure');
    }, disconnect);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({ exitCode: 1, errorCode: 'WORKER_UNHANDLED_ERROR' });
  });

  it('reports disconnect failure with a safe error code', async () => {
    const outcome = await executeScheduledWorkerLifecycle(
      async () => [{ status: 'SUCCESS' }],
      async () => {
        throw new Error('database-url-must-not-be-logged');
      },
    );
    expect(outcome).toMatchObject({ exitCode: 1, errorCode: 'WORKER_DISCONNECT_FAILED' });
    expect(formatScheduledWorkerLog(outcome)).not.toContain('database-url-must-not-be-logged');
  });
});
