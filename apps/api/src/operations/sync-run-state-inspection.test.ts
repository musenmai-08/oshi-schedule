import { describe, expect, it, vi } from 'vitest';
import { inspectInitialManualSyncRuns } from './sync-run-state-inspection.js';

describe('read-only SyncRun state inspection', () => {
  it('reads all INITIAL/MANUAL states with only SELECT operations', async () => {
    const at = new Date('2026-08-30T00:00:00.000Z');
    const syncRuns = {
      count: vi.fn(async () => 2),
      findMany: vi.fn(async () => [
        {
          id: 'run-success',
          status: 'SUCCESS' as const,
          type: 'INITIAL' as const,
          queuedAt: at,
          startedAt: at,
          completedAt: at,
          errorCode: null,
          requestedById: 'must-not-be-selected',
        },
        {
          id: 'run-failed',
          status: 'FAILED' as const,
          type: 'MANUAL' as const,
          queuedAt: at,
          startedAt: at,
          completedAt: at,
          errorCode: 'SYNC_FAILED',
        },
      ]),
    };

    await expect(inspectInitialManualSyncRuns(syncRuns)).resolves.toEqual({
      level: 'info',
      event: 'sync_run_state_inspection',
      mode: 'READ_ONLY',
      runCount: 2,
      runs: [
        {
          id: 'run-success',
          status: 'SUCCESS',
          trigger: 'INITIAL',
          queuedAt: at.toISOString(),
          startedAt: at.toISOString(),
          completedAt: at.toISOString(),
          errorCode: null,
        },
        {
          id: 'run-failed',
          status: 'FAILED',
          trigger: 'MANUAL',
          queuedAt: at.toISOString(),
          startedAt: at.toISOString(),
          completedAt: at.toISOString(),
          errorCode: 'SYNC_FAILED',
        },
      ],
      runsTruncated: false,
    });
    expect(syncRuns.count).toHaveBeenCalledWith({ where: { type: { in: ['INITIAL', 'MANUAL'] } } });
    expect(syncRuns.findMany).toHaveBeenCalledWith({
      where: { type: { in: ['INITIAL', 'MANUAL'] } },
      orderBy: { queuedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        status: true,
        type: true,
        queuedAt: true,
        startedAt: true,
        completedAt: true,
        errorCode: true,
      },
    });
  });

  it('marks an empty result without exposing raw error text', async () => {
    const syncRuns = { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) };
    await expect(inspectInitialManualSyncRuns(syncRuns)).resolves.toMatchObject({
      runCount: 0,
      runs: [],
      runsTruncated: false,
    });
  });
});
