import { describe, expect, it, vi } from 'vitest';
import type { SyncRunView } from '@oshi-schedule/shared';
import { pollSyncRun } from './api';

const run = (status: SyncRunView['status']): SyncRunView => ({
  id: 'cm0wz73bk0000qzrmn831i7rn',
  subscriptionId: 'cm0wz73bk0000qzrmn831i7ro',
  trigger: 'MANUAL',
  status,
  queuedAt: '2026-08-12T00:00:00.000Z',
  startedAt: status === 'QUEUED' ? null : '2026-08-12T00:00:01.000Z',
  finishedAt: status === 'SUCCESS' ? '2026-08-12T00:00:02.000Z' : null,
  error: null,
  result: {
    youtubeFetch: status === 'SUCCESS' ? 'SUCCESS' : 'NOT_STARTED',
    databaseUpdate: status === 'SUCCESS' ? 'SUCCESS' : 'NOT_STARTED',
    calendarSync: status === 'SUCCESS' ? 'SUCCESS' : 'NOT_STARTED',
    snapshotVersion: status === 'SUCCESS' ? 1 : null,
  },
});

describe('pollSyncRun', () => {
  it('reports queued and running states before terminating on success', async () => {
    const states = [run('QUEUED'), run('RUNNING'), run('SUCCESS')];
    const read = vi.fn(async () => states.shift()!);
    const wait = vi.fn(async () => undefined);
    const updates: string[] = [];
    expect(
      await pollSyncRun('cm0wz73bk0000qzrmn831i7rn', {
        read,
        wait,
        onUpdate: ({ status }) => updates.push(status),
      }),
    ).toMatchObject({ status: 'SUCCESS' });
    expect(updates).toEqual(['QUEUED', 'RUNNING', 'SUCCESS']);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('terminates after the configured attempt limit instead of polling forever', async () => {
    const read = vi.fn(async () => run('RUNNING'));
    expect(
      await pollSyncRun('cm0wz73bk0000qzrmn831i7rn', {
        read,
        wait: async () => undefined,
        maxAttempts: 3,
      }),
    ).toBeNull();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it.each(['FAILED', 'DEFERRED'] as const)(
    'stops immediately on %s so the UI can offer retry',
    async (status) => {
      const read = vi.fn(async () => run(status));
      expect(
        await pollSyncRun('cm0wz73bk0000qzrmn831i7rn', {
          read,
          wait: async () => undefined,
        }),
      ).toMatchObject({ status });
      expect(read).toHaveBeenCalledOnce();
    },
  );
});
