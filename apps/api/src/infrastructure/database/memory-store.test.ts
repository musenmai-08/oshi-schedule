import { describe, expect, it } from 'vitest';
import { MemoryStore } from './memory-store.js';
import type { NormalizedBroadcast } from '../../domain/scheduling.js';

describe('MemoryStore broadcast change tracking', () => {
  it('does not advance sourceUpdatedAt when the observed payload is unchanged', async () => {
    const store = new MemoryStore();
    const channel = await store.upsertChannel({
      id: 'external',
      youtubeChannelId: 'UC-change',
      title: 'channel',
      handle: '@change',
      thumbnailUrl: '',
      channelUrl: '',
    });
    const item: NormalizedBroadcast = {
      youtubeVideoId: 'video',
      title: 'title',
      kind: 'UNKNOWN',
      status: 'UPCOMING',
      youtubeUrl: 'https://youtube.example/video',
      thumbnailUrl: '',
      scheduledStartAt: new Date('2026-07-21T10:00:00Z'),
      endAt: new Date('2026-07-21T11:00:00Z'),
      endTimeProvisional: true,
      actualStartAt: null,
      actualEndAt: null,
    };
    const first = new Date('2026-07-20T10:00:00Z');
    const second = new Date('2026-07-20T11:00:00Z');
    await store.upsertBroadcasts(channel.id, [item], first);
    await store.upsertBroadcasts(channel.id, [item], second);
    expect(
      (await store.listBroadcastsForSync(channel.id, first, null))[0]?.sourceUpdatedAt,
    ).toEqual(first);
  });

  it('caps tracked broadcasts and excludes items outside the configured window', async () => {
    const store = new MemoryStore();
    const channel = await store.upsertChannel({
      id: 'external',
      youtubeChannelId: 'UC-track-cap',
      title: 'channel',
      handle: '@track-cap',
      thumbnailUrl: '',
      channelUrl: '',
    });
    const now = new Date('2026-07-22T00:00:00Z');
    const items = Array.from({ length: 101 }, (_, index): NormalizedBroadcast => ({
      youtubeVideoId: `video-${index}`,
      title: `title-${index}`,
      kind: 'UNKNOWN',
      status: 'LIVE',
      youtubeUrl: `https://youtube.example/video-${index}`,
      thumbnailUrl: '',
      scheduledStartAt:
        index === 100 ? new Date('2026-06-01T00:00:00Z') : new Date(now.getTime() - index * 60_000),
      endAt: new Date(now.getTime() + 60_000),
      endTimeProvisional: true,
      actualStartAt: null,
      actualEndAt: null,
    }));
    await store.upsertBroadcasts(channel.id, items, now);
    const tracked = await store.listTrackableBroadcasts(channel.id, now, 50, 30);
    expect(tracked).toHaveLength(50);
    expect(tracked.some((item) => item.youtubeVideoId === 'video-100')).toBe(false);
  });
});

describe('MemoryStore asynchronous sync claims', () => {
  it('deduplicates active jobs, claims atomically, and permits only stale redelivery', async () => {
    const store = new MemoryStore();
    const user = await store.ensureUser({ subject: 'job-owner', email: 'owner@example.com' });
    const channel = await store.upsertChannel({
      id: 'external',
      youtubeChannelId: 'UC-job',
      title: 'channel',
      handle: '@job',
      thumbnailUrl: '',
      channelUrl: '',
    });
    const subscription = await store.createSubscriptionWithinLimit(user.id, channel.id, 3);
    const queuedAt = new Date('2026-08-12T00:00:00Z');
    const first = await store.enqueueSyncRun(
      user.id,
      subscription.id,
      queuedAt,
      new Date(0),
      'MANUAL',
    );
    const duplicate = await store.enqueueSyncRun(
      user.id,
      subscription.id,
      queuedAt,
      new Date(0),
      'MANUAL',
    );
    expect(duplicate).toMatchObject({ created: false, run: { id: first.run.id } });

    const claimedAt = new Date('2026-08-12T00:01:00Z');
    expect(await store.claimSyncRun(first.run.id, claimedAt, new Date(0))).toMatchObject({
      status: 'RUNNING',
    });
    expect(await store.claimSyncRun(first.run.id, claimedAt, new Date(0))).toBeNull();
    expect(
      await store.claimSyncRun(
        first.run.id,
        new Date('2026-08-12T01:00:00Z'),
        new Date('2026-08-12T00:30:00Z'),
      ),
    ).toMatchObject({ status: 'RUNNING' });
  });
});
