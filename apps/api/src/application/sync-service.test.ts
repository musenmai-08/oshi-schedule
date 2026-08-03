import { describe, expect, it } from 'vitest';
import { SyncService } from './sync-service.js';
import { MemoryStore } from '../infrastructure/database/memory-store.js';
import { FakeCalendarGateway } from '../infrastructure/google-calendar/fake-calendar-gateway.js';
import { AppError } from '../domain/errors.js';
import type { AppLogger, MappingRecord, YouTubeGateway } from './models.js';
import type { NormalizedBroadcast } from '../domain/scheduling.js';

const logger: AppLogger = { info: () => undefined, error: () => undefined };
const start = new Date('2026-07-20T09:00:00.000Z');

class MutableYouTube implements YouTubeGateway {
  upcoming: NormalizedBroadcast[] = [];
  refreshed: NormalizedBroadcast[] = [];
  unavailableVideoIds: string[] = [];
  pause: Promise<void> | null = null;
  upcomingCalls = 0;
  async resolveHandle(handle: string) {
    return {
      id: 'external',
      youtubeChannelId: 'UC-sync',
      title: 'sync channel',
      handle,
      thumbnailUrl: '',
      channelUrl: '',
    };
  }
  async listUpcoming() {
    this.upcomingCalls += 1;
    if (this.pause) await this.pause;
    return this.upcoming;
  }
  async refreshBroadcasts() {
    return { items: this.refreshed, unavailableVideoIds: this.unavailableVideoIds };
  }
}

class FailOnceMappingStore extends MemoryStore {
  failed = false;
  override async saveMapping(input: Omit<MappingRecord, 'id'>) {
    if (!this.failed) {
      this.failed = true;
      throw new Error('database unavailable after calendar insert');
    }
    return super.saveMapping(input);
  }
}

class OneUserFailingCalendar extends FakeCalendarGateway {
  failUserId = '';
  override async ensureCalendar(user: Parameters<FakeCalendarGateway['ensureCalendar']>[0]) {
    if (user.id === this.failUserId)
      throw new AppError('GOOGLE_CALENDAR_ERROR', 'failed', 502, true);
    return super.ensureCalendar(user);
  }
}

class CountingCalendar extends FakeCalendarGateway {
  upserts = 0;
  override async upsertEvent(
    ...args: Parameters<FakeCalendarGateway['upsertEvent']>
  ): Promise<string> {
    this.upserts += 1;
    return super.upsertEvent(...args);
  }
}

async function setup(store: MemoryStore) {
  const user = await store.ensureUser({ subject: 'sync-user', email: 'developer@example.com' });
  await store.completeOnboarding(user.id, 'encrypted', 'v1', 'calendar-sync');
  const channel = await store.upsertChannel({
    id: 'external',
    youtubeChannelId: 'UC-sync',
    title: 'sync channel',
    handle: '@sync',
    thumbnailUrl: '',
    channelUrl: '',
  });
  const subscription = await store.createSubscriptionWithinLimit(user.id, channel.id, 3);
  return { user, channel, subscription };
}

const broadcast = (overrides: Partial<NormalizedBroadcast> = {}): NormalizedBroadcast => ({
  youtubeVideoId: 'video-1',
  title: '配信',
  kind: 'UNKNOWN',
  status: 'UPCOMING',
  youtubeUrl: 'https://youtube.example/video-1',
  thumbnailUrl: '',
  scheduledStartAt: start,
  endAt: new Date('2026-07-20T10:00:00.000Z'),
  endTimeProvisional: true,
  actualStartAt: null,
  actualEndAt: null,
  ...overrides,
});

describe('SyncService', () => {
  it('refreshes a stored started broadcast through videos details and applies the actual end once', async () => {
    const store = new MemoryStore();
    const { user, channel, subscription } = await setup(store);
    const observedAt = new Date('2026-07-20T10:30:00.000Z');
    const initialAt = new Date('2026-07-20T08:30:00.000Z');
    await store.upsertBroadcasts(channel.id, [broadcast()], initialAt);
    await store.updateChannelFetchedAt(channel.id, initialAt);
    const youtube = new MutableYouTube();
    youtube.refreshed = [
      broadcast({
        status: 'COMPLETED',
        actualStartAt: start,
        actualEndAt: new Date('2026-07-20T10:15:00.000Z'),
        endAt: new Date('2026-07-20T10:15:00.000Z'),
        endTimeProvisional: false,
      }),
    ];
    const calendar = new CountingCalendar();
    let current = initialAt;
    const clock = { now: () => current };
    const service = new SyncService(store, youtube, calendar, clock, logger);

    await service.syncSubscription(user.id, subscription.id, false);
    current = observedAt;
    await service.syncSubscription(user.id, subscription.id, false);
    const stored = await store.listBroadcastsForSync(channel.id, observedAt, null);
    expect(stored[0]).toMatchObject({ status: 'COMPLETED', endTimeProvisional: false });
    expect(stored[0]?.actualEndAt?.toISOString()).toBe('2026-07-20T10:15:00.000Z');
    expect([...calendar.events.values()][0]?.end).toBe('2026-07-20T10:15:00.000Z');

    await service.syncSubscription(user.id, subscription.id, false);
    expect(calendar.events.size).toBe(1);
    expect(calendar.upserts).toBe(2);
    expect(store.syncRuns.map((run) => run.status)).toEqual(['SUCCESS', 'SUCCESS', 'SUCCESS']);
  });

  it('recreates a manually deleted event even when managed fields are unchanged', async () => {
    const store = new MemoryStore();
    const { user, channel, subscription } = await setup(store);
    const item = broadcast({
      scheduledStartAt: new Date('2026-07-21T09:00:00Z'),
      endAt: new Date('2026-07-21T10:00:00Z'),
    });
    const youtube = new MutableYouTube();
    youtube.upcoming = [item];
    const calendar = new FakeCalendarGateway();
    let current = new Date('2026-07-20T10:00:00Z');
    const service = new SyncService(store, youtube, calendar, { now: () => current }, logger);
    await service.syncSubscription(user.id, subscription.id, false);
    const eventId = [...calendar.events.keys()][0]!;
    calendar.events.delete(eventId);
    current = new Date('2026-07-20T10:06:00Z');
    await service.syncSubscription(user.id, subscription.id, false);
    expect(calendar.events.size).toBe(1);
    const recreatedId = [...calendar.events.keys()][0]!;
    expect(recreatedId).not.toBe(eventId);
    const [stored] = await store.listBroadcastsForSync(channel.id, current, null);
    expect((await store.getMapping(user.id, stored!.id))?.eventId).toBe(recreatedId);
  });

  it('uses a deterministic event ID so a mapping write failure cannot duplicate an event', async () => {
    const store = new FailOnceMappingStore();
    const { user, subscription } = await setup(store);
    const youtube = new MutableYouTube();
    youtube.upcoming = [
      broadcast({
        scheduledStartAt: new Date('2026-07-21T09:00:00Z'),
        endAt: new Date('2026-07-21T10:00:00Z'),
      }),
    ];
    const calendar = new FakeCalendarGateway();
    const service = new SyncService(
      store,
      youtube,
      calendar,
      { now: () => new Date('2026-07-20T10:00:00Z') },
      logger,
    );
    await expect(service.syncSubscription(user.id, subscription.id, false)).rejects.toThrow(
      'database unavailable',
    );
    await service.syncSubscription(user.id, subscription.id, false);
    expect(calendar.events.size).toBe(1);
    expect(store.syncRuns.map((run) => run.status)).toEqual(['FAILED', 'SUCCESS']);
  });

  it('creates and updates an event with a title-only summary and no thumbnail description', async () => {
    const store = new MemoryStore();
    const { user, channel, subscription } = await setup(store);
    const now = new Date('2026-07-20T10:00:00Z');
    await store.updateChannelFetchedAt(channel.id, now);
    const [stored] = await store.upsertBroadcasts(
      channel.id,
      [
        broadcast({
          youtubeVideoId: 'display-contract',
          title: '新作ゲームをプレイします',
          kind: 'PREMIERE',
          youtubeUrl: 'https://youtu.be/display-contract',
          thumbnailUrl: 'https://i.ytimg.com/display-contract.jpg',
          scheduledStartAt: new Date('2026-07-21T09:00:00Z'),
          endAt: new Date('2026-07-21T09:30:00Z'),
        }),
      ],
      now,
    );
    const calendar = new CountingCalendar();
    const service = new SyncService(
      store,
      new MutableYouTube(),
      calendar,
      { now: () => now },
      logger,
    );
    const expected = {
      summary: '新作ゲームをプレイします',
      description:
        'チャンネル: sync channel\n種別: プレミア公開\nURL: https://youtu.be/display-contract',
    };

    await service.syncSubscription(user.id, subscription.id, false);
    expect(calendar.upserts).toBe(1);
    const [eventId] = calendar.events.keys();
    expect(calendar.events.get(eventId!)).toMatchObject(expected);

    const mapping = await store.getMapping(user.id, stored!.id);
    expect(mapping?.eventId).toBe(eventId);
    calendar.events.set(eventId!, {
      ...calendar.events.get(eventId!)!,
      summary: '【プレミア公開】新作ゲームをプレイします',
      description: `${expected.description}\nサムネイル: https://i.ytimg.com/display-contract.jpg`,
    });
    await store.saveMapping({
      userId: user.id,
      broadcastId: stored!.id,
      eventId: eventId!,
      managedFieldsHash: 'legacy-display-format',
    });
    calendar.upserts = 0;

    await service.syncSubscription(user.id, subscription.id, false);
    expect(calendar.upserts).toBe(1);
    expect(calendar.events.get(eventId!)).toMatchObject(expected);
    expect(calendar.events.get(eventId!)?.description).not.toContain('サムネイル');
    expect((await store.getMapping(user.id, stored!.id))?.managedFieldsHash).not.toBe(
      'legacy-display-format',
    );
  });

  it('rejects a concurrent manual sync while a scheduled sync holds the shared lease', async () => {
    const store = new MemoryStore();
    const { user, subscription } = await setup(store);
    const youtube = new MutableYouTube();
    let release!: () => void;
    youtube.pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new SyncService(
      store,
      youtube,
      new FakeCalendarGateway(),
      { now: () => new Date('2026-07-20T10:00:00Z') },
      logger,
    );
    const first = service.syncSubscription(user.id, subscription.id, false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(service.syncSubscription(user.id, subscription.id)).rejects.toMatchObject({
      code: 'SYNC_ALREADY_RUNNING',
    });
    release();
    await first;
  });

  it('persists a partial scheduled run while continuing with the next user', async () => {
    const store = new MemoryStore();
    const first = await setup(store);
    const secondUser = await store.ensureUser({
      subject: 'sync-user-2',
      email: 'second@example.com',
    });
    await store.completeOnboarding(secondUser.id, 'encrypted', 'v1', 'calendar-2');
    await store.createSubscriptionWithinLimit(secondUser.id, first.channel.id, 3);
    const calendar = new OneUserFailingCalendar();
    calendar.failUserId = first.user.id;
    const service = new SyncService(
      store,
      new MutableYouTube(),
      calendar,
      { now: () => new Date('2026-07-20T10:00:00Z') },
      logger,
    );
    expect(await service.runScheduled()).toEqual([
      { subscriptionId: first.subscription.id, status: 'FAILED' },
      { subscriptionId: expect.any(String), status: 'SUCCESS' },
    ]);
    expect(store.syncRuns).toHaveLength(1);
    expect(store.syncRuns[0]?.status).toBe('PARTIAL_FAILED');
    expect(store.syncTargets.map((target) => target.status).sort()).toEqual(['FAILED', 'SUCCESS']);
  });

  it('records an all-failed scheduled run', async () => {
    const store = new MemoryStore();
    const target = await setup(store);
    const calendar = new OneUserFailingCalendar();
    calendar.failUserId = target.user.id;
    const service = new SyncService(
      store,
      new MutableYouTube(),
      calendar,
      { now: () => new Date('2026-07-20T10:00:00Z') },
      logger,
    );
    expect(await service.runScheduled()).toEqual([
      { subscriptionId: target.subscription.id, status: 'FAILED' },
    ]);
    expect(store.syncRuns[0]?.status).toBe('FAILED');
  });

  it('records an empty scheduled run as successful', async () => {
    const store = new MemoryStore();
    const service = new SyncService(
      store,
      new MutableYouTube(),
      new FakeCalendarGateway(),
      { now: () => new Date('2026-07-20T10:00:00Z') },
      logger,
    );
    await expect(service.runScheduled()).resolves.toEqual([]);
    expect(store.syncRuns[0]?.status).toBe('SUCCESS');
  });

  it('skips reauthentication users and resumes them after reconnect', async () => {
    const store = new MemoryStore();
    const { user, subscription } = await setup(store);
    const service = new SyncService(
      store,
      new MutableYouTube(),
      new FakeCalendarGateway(),
      { now: () => new Date('2026-07-20T10:00:00Z') },
      logger,
    );
    await store.markReauthRequired(user.id);
    await expect(service.runScheduled()).resolves.toEqual([]);
    await store.completeOnboarding(user.id, 'new-encrypted', 'v1', 'calendar-sync');
    await expect(service.runScheduled()).resolves.toEqual([
      { subscriptionId: subscription.id, status: 'SUCCESS' },
    ]);
  });

  it('recovers stale RUNNING history and retains recent history', async () => {
    const store = new MemoryStore();
    const { user, subscription } = await setup(store);
    const staleAt = new Date('2026-07-18T10:00:00Z');
    const staleRun = await store.startSyncRun('MANUAL', user.id, 1, staleAt);
    await store.startSyncTarget(staleRun, subscription.id, staleAt);
    const recentAt = new Date('2026-07-20T09:00:00Z');
    const recentRun = await store.startSyncRun('MANUAL', user.id, 0, recentAt);
    await store.finishSyncRun(recentRun, 'SUCCESS', recentAt);
    const expiredAt = new Date('2026-03-01T00:00:00Z');
    const expiredRun = await store.startSyncRun('MANUAL', user.id, 0, expiredAt);
    await store.finishSyncRun(expiredRun, 'SUCCESS', expiredAt);
    const service = new SyncService(
      store,
      new MutableYouTube(),
      new FakeCalendarGateway(),
      { now: () => new Date('2026-07-20T10:00:00Z') },
      logger,
    );
    await service.runScheduled();
    expect(store.syncRuns.find((run) => run.id === staleRun)).toMatchObject({
      status: 'FAILED',
      completedAt: new Date('2026-07-20T10:00:00Z'),
    });
    expect(store.syncTargets.find((target) => target.runId === staleRun)?.status).toBe('FAILED');
    expect(store.syncRuns.some((run) => run.id === recentRun)).toBe(true);
    expect(store.syncRuns.some((run) => run.id === expiredRun)).toBe(false);
  });

  it('creates only future or live events when no mapping exists, regardless of provisional end', async () => {
    const store = new MemoryStore();
    const { user, channel, subscription } = await setup(store);
    const now = new Date('2026-07-20T10:00:00Z');
    await store.updateChannelFetchedAt(channel.id, now);
    await store.upsertBroadcasts(
      channel.id,
      [
        broadcast({ youtubeVideoId: 'past-completed', status: 'COMPLETED' }),
        broadcast({ youtubeVideoId: 'past-unavailable', status: 'UNAVAILABLE' }),
        broadcast({
          youtubeVideoId: 'past-upcoming',
          status: 'UPCOMING',
          scheduledStartAt: new Date('2026-07-20T08:00:00Z'),
          endAt: new Date('2026-07-20T09:00:00Z'),
        }),
        broadcast({
          youtubeVideoId: 'overrunning-live',
          status: 'LIVE',
          actualStartAt: new Date('2026-07-20T09:00:00Z'),
          endAt: new Date('2026-07-20T09:30:00Z'),
          endTimeProvisional: true,
        }),
        broadcast({
          youtubeVideoId: 'future-upcoming',
          status: 'UPCOMING',
          scheduledStartAt: new Date('2026-07-21T09:00:00Z'),
          endAt: new Date('2026-07-21T10:00:00Z'),
        }),
      ],
      now,
    );
    const calendar = new CountingCalendar();
    const service = new SyncService(
      store,
      new MutableYouTube(),
      calendar,
      { now: () => now },
      logger,
    );

    await service.syncSubscription(user.id, subscription.id, false);
    await service.syncSubscription(user.id, subscription.id, false);
    expect(calendar.events.size).toBe(2);
    expect(
      [...calendar.events.values()]
        .map((event) => event.extendedProperties.private.youtubeVideoId)
        .sort(),
    ).toEqual(['future-upcoming', 'overrunning-live']);
    expect(calendar.upserts).toBe(2);
  });

  it('updates mapped past completed and unavailable events without backfilling unmapped history', async () => {
    const store = new MemoryStore();
    const { user, channel, subscription } = await setup(store);
    const now = new Date('2026-07-20T10:00:00Z');
    await store.updateChannelFetchedAt(channel.id, now);
    const [completed, unavailable] = await store.upsertBroadcasts(
      channel.id,
      [
        broadcast({ youtubeVideoId: 'mapped-completed', status: 'COMPLETED' }),
        broadcast({ youtubeVideoId: 'mapped-unavailable', status: 'UNAVAILABLE' }),
      ],
      now,
    );
    const calendar = new CountingCalendar();
    for (const [item, eventId] of [
      [completed!, 'mappedcompleted'],
      [unavailable!, 'mappedunavailable'],
    ] as const) {
      await calendar.upsertEvent(
        user,
        'calendar-sync',
        eventId,
        {
          summary: 'old',
          description: 'old',
          start: start.toISOString(),
          end: start.toISOString(),
          status: 'confirmed',
          extendedProperties: { private: { youtubeVideoId: item.youtubeVideoId } },
        },
        true,
      );
      await store.saveMapping({
        userId: user.id,
        broadcastId: item.id,
        eventId,
        managedFieldsHash: 'old-hash',
      });
    }
    calendar.upserts = 0;
    await new SyncService(
      store,
      new MutableYouTube(),
      calendar,
      { now: () => now },
      logger,
    ).syncSubscription(user.id, subscription.id, false);
    expect(calendar.upserts).toBe(2);
    expect(calendar.events.size).toBe(2);
  });

  it('uses cached broadcasts and records a deferred target when quota is unavailable', async () => {
    const store = new MemoryStore();
    const { user, channel, subscription } = await setup(store);
    const now = new Date('2026-07-20T10:00:00Z');
    await store.upsertBroadcasts(
      channel.id,
      [
        broadcast({
          youtubeVideoId: 'cached-future',
          scheduledStartAt: new Date('2026-07-21T09:00:00Z'),
          endAt: new Date('2026-07-21T10:00:00Z'),
        }),
      ],
      now,
    );
    const youtube = new MutableYouTube();
    youtube.listUpcoming = async () => {
      throw new AppError('YOUTUBE_QUOTA_DEFERRED', 'deferred', 429, true, {
        nextRetryAt: '2026-07-21T07:00:00.000Z',
      });
    };
    const calendar = new FakeCalendarGateway();
    const result = await new SyncService(
      store,
      youtube,
      calendar,
      { now: () => now },
      logger,
    ).syncSubscription(user.id, subscription.id, false);
    expect(result).toMatchObject({ status: 'DEFERRED', nextRetryAt: '2026-07-21T07:00:00.000Z' });
    expect(store.syncRuns[0]?.status).toBe('DEFERRED');
    expect(calendar.events.size).toBe(1);
    expect(store.syncTargets[0]?.status).toBe('DEFERRED');
    expect(
      (await store.getSubscription(user.id, subscription.id))?.subscription.lastSyncStatus,
    ).toBe('DEFERRED');
    expect((await store.listBroadcastsForSync(channel.id, now, null))[0]?.status).toBe('UPCOMING');
  });

  it('fetches a shared YouTube channel once for multiple scheduled subscribers', async () => {
    const store = new MemoryStore();
    const first = await setup(store);
    const secondUser = await store.ensureUser({ subject: 'shared-2', email: 'second@example.com' });
    await store.completeOnboarding(secondUser.id, 'encrypted', 'v1', 'calendar-2');
    await store.createSubscriptionWithinLimit(secondUser.id, first.channel.id, 3);
    const youtube = new MutableYouTube();
    await new SyncService(
      store,
      youtube,
      new FakeCalendarGateway(),
      { now: () => new Date('2026-07-20T10:00:00Z') },
      logger,
    ).runScheduled();
    expect(youtube.upcomingCalls).toBe(1);
  });

  it('waits for a shared channel snapshot and fans it out to both concurrent users', async () => {
    const store = new MemoryStore();
    const first = await setup(store);
    const secondUser = await store.ensureUser({ subject: 'parallel-2', email: 'two@example.com' });
    await store.completeOnboarding(secondUser.id, 'encrypted', 'v1', 'calendar-2');
    const secondSubscription = await store.createSubscriptionWithinLimit(
      secondUser.id,
      first.channel.id,
      3,
    );
    const youtube = new MutableYouTube();
    youtube.upcoming = [
      broadcast({
        scheduledStartAt: new Date('2026-07-21T09:00:00Z'),
        endAt: new Date('2026-07-21T10:00:00Z'),
      }),
    ];
    let release!: () => void;
    youtube.pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calendar = new FakeCalendarGateway();
    const clock = { now: () => new Date('2026-07-20T10:00:00Z') };
    const firstWorker = new SyncService(store, youtube, calendar, clock, logger);
    const secondWorker = new SyncService(store, youtube, calendar, clock, logger);
    const owner = firstWorker.syncSubscription(first.user.id, first.subscription.id, false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const follower = secondWorker.syncSubscription(secondUser.id, secondSubscription.id, false);
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await expect(Promise.all([owner, follower])).resolves.toMatchObject([
      { status: 'SUCCESS', snapshotVersion: 1 },
      { status: 'SUCCESS', snapshotVersion: 1 },
    ]);
    expect(youtube.upcomingCalls).toBe(1);
    expect(calendar.events.size).toBe(2);
    expect(store.syncTargets.map((target) => target.calendarSyncStatus)).toEqual([
      'SUCCESS',
      'SUCCESS',
    ]);
  });

  it('returns DEFERRED instead of false SUCCESS while another worker has no completed snapshot', async () => {
    const store = new MemoryStore();
    const { user, channel, subscription } = await setup(store);
    expect(
      await store.acquireSyncLease(
        `youtube-channel:${channel.id}`,
        'other-worker',
        new Date('2026-07-20T10:00:00Z'),
        60_000,
      ),
    ).not.toBeNull();
    const result = await new SyncService(
      store,
      new MutableYouTube(),
      new FakeCalendarGateway(),
      { now: () => new Date('2026-07-20T10:00:00Z') },
      logger,
      60_000,
      {
        maxTrackedBroadcastsPerChannel: 50,
        trackingWindowDays: 30,
        snapshotWaitMs: 0,
        snapshotPollMs: 1,
      },
    ).syncSubscription(user.id, subscription.id, false);
    expect(result).toMatchObject({
      status: 'DEFERRED',
      phases: {
        youtubeFetch: 'DEFERRED',
        databaseUpdate: 'SKIPPED',
        calendarSync: 'SUCCESS',
      },
    });
    expect(store.syncTargets[0]?.status).toBe('DEFERRED');
  });

  it('includes the persisted run ID in failure logs', async () => {
    const store = new MemoryStore();
    const { user, subscription } = await setup(store);
    const entries: Array<Record<string, unknown>> = [];
    const recordingLogger: AppLogger = {
      info: () => undefined,
      error: (data) => entries.push(data),
    };
    const calendar = new OneUserFailingCalendar();
    calendar.failUserId = user.id;
    await expect(
      new SyncService(
        store,
        new MutableYouTube(),
        calendar,
        { now: () => new Date('2026-07-20T10:00:00Z') },
        recordingLogger,
      ).syncSubscription(user.id, subscription.id, false),
    ).rejects.toBeInstanceOf(AppError);
    expect(entries[0]).toMatchObject({
      subscriptionId: subscription.id,
      runId: store.syncRuns[0]?.id,
      errorCode: 'GOOGLE_CALENDAR_ERROR',
    });
  });
});
