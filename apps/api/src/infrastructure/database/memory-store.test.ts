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
    expect((await store.listBroadcastsForSync(channel.id, first, null))[0]?.apiFetchedAt).toEqual(
      second,
    );
  });

  it('removes expired channel IDs, subscriptions, and broadcasts', async () => {
    const store = new MemoryStore();
    const user = await store.ensureUser({ subject: 'retention', email: 'owner@example.com' });
    const channel = await store.upsertChannel({
      id: 'external',
      youtubeChannelId: 'UC-retention',
      title: 'Old title',
      handle: '@old',
      thumbnailUrl: 'https://example.com/old.png',
      channelUrl: 'https://example.com/old',
    });
    await store.createSubscriptionWithinLimit(user.id, channel.id, 3);
    channel.metadataFetchedAt = new Date('2026-07-01T00:00:00Z');
    const oldVideo: NormalizedBroadcast = {
      youtubeVideoId: 'old-video',
      title: 'Old stream',
      kind: 'UNKNOWN',
      status: 'COMPLETED',
      youtubeUrl: 'https://youtube.example/old-video',
      thumbnailUrl: '',
      scheduledStartAt: new Date('2026-07-01T00:00:00Z'),
      endAt: new Date('2026-07-01T01:00:00Z'),
      endTimeProvisional: false,
      actualStartAt: null,
      actualEndAt: new Date('2026-07-01T01:00:00Z'),
    };
    await store.upsertBroadcasts(channel.id, [oldVideo], new Date('2026-07-01T00:00:00Z'));
    await store.maintainYouTubeData(new Date('2026-07-02T00:00:00Z'));
    expect(
      await store.listBroadcastsForSync(channel.id, new Date('2026-08-01T00:00:00Z'), null),
    ).toEqual([]);
    expect(await store.findChannelById(channel.id)).toBeNull();
    expect((await store.findUserById(user.id))?.channelReregistrationRequired).toBe(true);
    expect(
      await store.listChannelsNeedingMetadataRefresh(new Date('2026-08-01T00:00:00Z')),
    ).toHaveLength(0);
    expect(await store.countStaleYouTubeData(new Date('2026-07-02T00:00:00Z'))).toEqual({
      channels: 0,
      broadcasts: 0,
    });
  });

  it('uses creation time for legacy NULL fetch timestamps and preserves the 22-day boundary', async () => {
    const store = new MemoryStore();
    const user = await store.ensureUser({ subject: 'legacy', email: 'legacy@example.com' });
    const channel = await store.upsertChannel({
      id: 'legacy',
      youtubeChannelId: 'UC-legacy',
      title: 'Legacy',
      handle: '@legacy',
      thumbnailUrl: 'old',
      channelUrl: 'old',
    });
    await store.createSubscriptionWithinLimit(user.id, channel.id, 3);
    channel.createdAt = new Date('2026-07-01T00:00:00Z');
    channel.metadataFetchedAt = null;
    const [broadcast] = await store.upsertBroadcasts(
      channel.id,
      [
        {
          youtubeVideoId: 'legacy-video',
          title: 'Legacy stream',
          kind: 'LIVE',
          status: 'COMPLETED',
          youtubeUrl: 'old',
          thumbnailUrl: 'old',
          scheduledStartAt: channel.createdAt,
          endAt: new Date('2026-07-01T01:00:00Z'),
          endTimeProvisional: false,
          actualStartAt: null,
          actualEndAt: new Date('2026-07-01T01:00:00Z'),
        },
      ],
      channel.createdAt,
    );
    broadcast!.apiFetchedAt = null;
    broadcast!.createdAt = channel.createdAt;
    await store.maintainYouTubeData(new Date('2026-07-01T00:00:00Z'));
    expect((await store.findChannelById(channel.id))?.title).toBe('Legacy');
    expect(await store.listBroadcastsForSync(channel.id, channel.createdAt, null)).toHaveLength(1);
    await store.maintainYouTubeData(new Date('2026-07-01T00:00:00.001Z'));
    expect(await store.findChannelById(channel.id)).toBeNull();
    expect((await store.findUserById(user.id))?.channelReregistrationRequired).toBe(true);
    expect(await store.listBroadcastsForSync(channel.id, channel.createdAt, null)).toHaveLength(0);
  });

  it('does not return 30-day-old broadcast data when cleanup has not run', async () => {
    const store = new MemoryStore();
    const channel = await store.upsertChannel({
      id: 'expired-video', youtubeChannelId: 'UC-expired-video', title: 'channel', handle: '@expired', thumbnailUrl: '', channelUrl: '',
    });
    const now = new Date('2026-08-01T00:00:00Z');
    const old = new Date(now.getTime() - 30 * 86_400_000);
    const [saved] = await store.upsertBroadcasts(channel.id, [{
      youtubeVideoId: 'expired-video', title: 'old', kind: 'LIVE', status: 'UPCOMING', youtubeUrl: 'old', thumbnailUrl: '',
      scheduledStartAt: new Date(now.getTime() + 86_400_000), endAt: new Date(now.getTime() + 2 * 86_400_000),
      endTimeProvisional: true, actualStartAt: null, actualEndAt: null,
    }], old);
    saved!.apiFetchedAt = null;
    saved!.createdAt = old;
    expect(await store.listFutureBroadcasts(channel.id, now)).toHaveLength(0);
    expect(await store.listTrackableBroadcasts(channel.id, now, 50, 30)).toHaveLength(0);
    expect(await store.listBroadcastsForSync(channel.id, now, null)).toHaveLength(0);
    expect(store.broadcasts).toHaveLength(1);
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
