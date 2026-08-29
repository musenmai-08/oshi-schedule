import { describe, expect, it, vi } from 'vitest';
import { inspectQueuedSyncRuns } from './queued-sync-run-inspection.js';

const at = new Date('2026-08-29T00:00:00.000Z');

describe('queued SyncRun inspection', () => {
  it('uses only count/findMany and clearly reports no candidate', async () => {
    const syncRuns = { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) };
    await expect(inspectQueuedSyncRuns(syncRuns)).resolves.toEqual({
      level: 'info',
      event: 'queued_sync_run_inspection',
      mode: 'READ_ONLY',
      selection: 'NONE',
      candidateCount: 0,
      candidates: [],
      candidatesTruncated: false,
    });
    expect(syncRuns.count).toHaveBeenCalledWith({
      where: { status: 'QUEUED', type: { in: ['INITIAL', 'MANUAL'] } },
    });
    expect(syncRuns.findMany).toHaveBeenCalledWith({
      where: { status: 'QUEUED', type: { in: ['INITIAL', 'MANUAL'] } },
      orderBy: { queuedAt: 'asc' },
      take: 2,
      select: { id: true, status: true, type: true, queuedAt: true },
    });
  });

  it('outputs only safe fields for the exactly-one candidate', async () => {
    const syncRuns = {
      count: vi.fn(async () => 1),
      findMany: vi.fn(async () => [
        {
          id: 'safe-run-id',
          status: 'QUEUED' as const,
          type: 'MANUAL' as const,
          queuedAt: at,
          requestedById: 'must-not-be-selected',
        },
      ]),
    };
    const result = await inspectQueuedSyncRuns(syncRuns);
    expect(result).toEqual({
      level: 'info',
      event: 'queued_sync_run_inspection',
      mode: 'READ_ONLY',
      selection: 'EXACTLY_ONE',
      candidateCount: 1,
      candidates: [
        { id: 'safe-run-id', status: 'QUEUED', trigger: 'MANUAL', queuedAt: at.toISOString() },
      ],
      candidatesTruncated: false,
    });
    expect(JSON.stringify(result)).not.toContain('must-not-be-selected');
  });

  it('distinguishes multiple candidates and caps displayed candidates at two', async () => {
    const syncRuns = {
      count: vi.fn(async () => 3),
      findMany: vi.fn(async () => [
        { id: 'first', status: 'QUEUED' as const, type: 'INITIAL' as const, queuedAt: at },
        { id: 'second', status: 'QUEUED' as const, type: 'MANUAL' as const, queuedAt: at },
      ]),
    };
    await expect(inspectQueuedSyncRuns(syncRuns)).resolves.toMatchObject({
      selection: 'MULTIPLE',
      candidateCount: 3,
      candidatesTruncated: true,
      candidates: [
        { id: 'first', status: 'QUEUED', trigger: 'INITIAL' },
        { id: 'second', status: 'QUEUED', trigger: 'MANUAL' },
      ],
    });
  });
});
