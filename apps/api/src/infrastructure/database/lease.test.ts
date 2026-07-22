import { describe, expect, it } from 'vitest';
import { MemoryStore } from './memory-store.js';

describe('lease fencing contract', () => {
  it('blocks before expiry, allows takeover after expiry, and rejects stale renew/release', async () => {
    const store = new MemoryStore();
    const start = new Date('2026-07-20T10:00:00Z');
    const first = await store.acquireSyncLease('job', 'owner-a', start, 60_000);
    expect(first).toMatchObject({ version: 1 });
    expect(
      await store.acquireSyncLease('job', 'owner-b', new Date('2026-07-20T10:00:59Z'), 60_000),
    ).toBeNull();
    expect(await store.renewSyncLease(first!, new Date('2026-07-20T10:00:30Z'), 60_000)).toBe(true);
    const second = await store.acquireSyncLease(
      'job',
      'owner-b',
      new Date('2026-07-20T10:01:31Z'),
      60_000,
    );
    expect(second).toMatchObject({ version: 2 });
    expect(await store.renewSyncLease(first!, new Date('2026-07-20T10:01:31Z'), 60_000)).toBe(
      false,
    );
    expect(await store.releaseSyncLease(first!)).toBe(false);
    expect(await store.releaseSyncLease(second!)).toBe(true);
  });

  it('does not block an unrelated key', async () => {
    const store = new MemoryStore();
    const now = new Date('2026-07-20T10:00:00Z');
    expect(await store.acquireSyncLease('channel-a', 'owner', now, 60_000)).not.toBeNull();
    expect(await store.acquireSyncLease('channel-b', 'owner', now, 60_000)).not.toBeNull();
  });

  it('rejects deletion state writes from a non-owner or stale fencing version', async () => {
    const store = new MemoryStore();
    const now = new Date('2026-07-20T10:00:00Z');
    const user = await store.ensureUser({ subject: 'deletion', email: 'developer@example.com' });
    const deletion = await store.beginAccountDeletion(user);
    const lease = (await store.acquireSyncLease(
      'account-deletion:deletion',
      'owner',
      now,
      60_000,
    ))!;
    expect(
      await store.markAccountDeletionStep(deletion.id, 'CALENDAR_DELETED', now, {
        ...lease,
        ownerToken: 'other',
      }),
    ).toBe(false);
    expect(
      await store.markAccountDeletionStep(deletion.id, 'CALENDAR_DELETED', now, {
        ...lease,
        version: lease.version - 1,
      }),
    ).toBe(false);
    expect(await store.markAccountDeletionStep(deletion.id, 'CALENDAR_DELETED', now, lease)).toBe(
      true,
    );
  });
});
