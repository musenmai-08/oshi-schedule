import { describe, expect, it, vi } from 'vitest';
import { SyncService } from './sync-service.js';
import { MemoryStore } from '../infrastructure/database/memory-store.js';
import { FakeCalendarGateway } from '../infrastructure/google-calendar/fake-calendar-gateway.js';
import { GoogleCalendarGateway } from '../infrastructure/google-calendar/google-calendar-gateway.js';
import { AesTokenCipher } from '../infrastructure/encryption/aes-token-cipher.js';
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
  channelRefreshCalls = 0;
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
  async resolveChannelId(youtubeChannelId: string) {
    this.channelRefreshCalls += 1;
    return {
      id: youtubeChannelId,
      youtubeChannelId,
      title: 'sync channel',
      handle: '@sync',
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

class ClaimFailingStore extends MemoryStore {
  override async claimSyncRun() {
    const error = new Error('database-url-must-not-be-logged');
    error.name = 'PrismaClientInitializationError';
    throw error;
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

class FailingDeleteCalendar extends FakeCalendarGateway {
  override async deleteEvent() {
    throw new AppError('GOOGLE_EVENT_DELETE_FAILED', 'failed', 502);
  }
}

async function setup(store: MemoryStore) {
  const user = await store.ensureUser({ subject: 'sync-user', email: 'developer@example.com' });
  await store.completeOnboarding(
    user.id,
    'encrypted',
    'v1',
    'calendar-sync',
    'openid email profile https://www.googleapis.com/auth/calendar.app.created',
  );
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
  it('refreshes channel metadata for a paused subscription before the retention deadline', async () => {
    const store = new MemoryStore();
    const { user, channel, subscription } = await setup(store);
    channel.metadataFetchedAt = new Date('2026-07-01T00:00:00Z');
    await store.updateSubscription(user.id, subscription.id, 'PAUSED');
    const youtube = new MutableYouTube();
    const sync = new SyncService(
      store,
      youtube,
      new FakeCalendarGateway(),
      { now: () => start },
      logger,
    );
    await sync.runScheduled();
    expect(youtube.channelRefreshCalls).toBe(1);
    expect((await store.findChannelById(channel.id))?.metadataFetchedAt).not.toEqual(
      new Date('2026-07-01T00:00:00Z'),
    );
    expect((await store.getSubscription(user.id, subscription.id))?.subscription.status).toBe(
      'PAUSED',
    );
  });
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
    expect(recreatedId).toBe(eventId);
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
        'Channel: sync channel\nType: YouTube Premiere\nURL: https://youtu.be/display-contract',
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
    await store.completeOnboarding(
      secondUser.id,
      'encrypted',
      'v1',
      'calendar-2',
      'openid email profile https://www.googleapis.com/auth/calendar.app.created',
    );
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
    await store.completeOnboarding(
      user.id,
      'new-encrypted',
      'v1',
      'calendar-sync',
      'openid email profile https://www.googleapis.com/auth/calendar.app.created',
    );
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

  it('purges only completed account-deletion tombstones after thirty days', async () => {
    const store = new MemoryStore();
    const oldUser = await store.ensureUser({ subject: 'old-deletion', email: 'old@example.com' });
    const recentUser = await store.ensureUser({
      subject: 'recent-deletion',
      email: 'recent@example.com',
    });
    const failedUser = await store.ensureUser({
      subject: 'failed-deletion',
      email: 'failed@example.com',
    });
    const oldDeletion = await store.beginAccountDeletion(oldUser);
    const recentDeletion = await store.beginAccountDeletion(recentUser);
    const failedDeletion = await store.beginAccountDeletion(failedUser);
    const now = new Date('2026-07-20T10:00:00Z');
    const oldLease = await store.acquireSyncLease(
      'deletion:old',
      'old-owner',
      now,
      60 * 24 * 60 * 60_000,
    );
    const recentLease = await store.acquireSyncLease(
      'deletion:recent',
      'recent-owner',
      now,
      60 * 24 * 60 * 60_000,
    );
    const failedLease = await store.acquireSyncLease(
      'deletion:failed',
      'failed-owner',
      now,
      60 * 24 * 60 * 60_000,
    );
    expect(oldLease).not.toBeNull();
    expect(recentLease).not.toBeNull();
    expect(failedLease).not.toBeNull();
    await store.markAccountDeletionStep(
      oldDeletion.id,
      'COMPLETED',
      new Date('2026-06-01T00:00:00Z'),
      oldLease!,
    );
    await store.markAccountDeletionStep(
      recentDeletion.id,
      'COMPLETED',
      new Date('2026-07-01T00:00:00Z'),
      recentLease!,
    );
    await store.markAccountDeletionFailed(
      failedDeletion.id,
      'GOOGLE_DELETE_RETRY',
      new Date('2026-06-01T00:00:00Z'),
      failedLease!,
    );
    const service = new SyncService(
      store,
      new MutableYouTube(),
      new FakeCalendarGateway(),
      { now: () => now },
      logger,
    );

    await service.runScheduled();

    expect(await store.findAccountDeletion('old-deletion')).toBeNull();
    expect(await store.findAccountDeletion('recent-deletion')).toMatchObject({
      status: 'COMPLETED',
    });
    expect(await store.findAccountDeletion('failed-deletion')).toMatchObject({ status: 'FAILED' });
  });

  it('recovers a queued targeted run when the next worker starts', async () => {
    const store = new MemoryStore();
    const { user, subscription } = await setup(store);
    const service = new SyncService(
      store,
      new MutableYouTube(),
      new FakeCalendarGateway(),
      { now: () => new Date('2026-07-20T10:00:00Z') },
      logger,
    );
    const queued = await service.queueSubscription(user.id, subscription.id);

    await expect(service.runPendingManual()).resolves.toEqual([
      expect.objectContaining({ status: 'SUCCESS' }),
    ]);
    expect(store.syncRuns.find((run) => run.id === queued.run.id)).toMatchObject({
      status: 'SUCCESS',
    });
  });

  it('claims one targeted run only once when two SQS worker invocations overlap', async () => {
    const store = new MemoryStore();
    const { user, subscription } = await setup(store);
    const clock = { now: () => new Date('2026-07-20T10:00:00Z') };
    const first = new SyncService(
      store,
      new MutableYouTube(),
      new FakeCalendarGateway(),
      clock,
      logger,
    );
    const second = new SyncService(
      store,
      new MutableYouTube(),
      new FakeCalendarGateway(),
      clock,
      logger,
    );
    const queued = await first.queueSubscription(user.id, subscription.id);

    const results = await Promise.all([
      first.runTargeted(queued.run.id),
      second.runTargeted(queued.run.id),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual(['SKIPPED', 'SUCCESS']);
    expect(store.syncRuns.find((run) => run.id === queued.run.id)).toMatchObject({
      status: 'SUCCESS',
    });
    expect(store.syncTargets.filter((target) => target.runId === queued.run.id)).toHaveLength(1);
  });

  it('classifies a targeted SyncRun claim database failure without retaining the cause', async () => {
    const service = new SyncService(
      new ClaimFailingStore(),
      new MutableYouTube(),
      new FakeCalendarGateway(),
      { now: () => new Date('2026-07-20T10:00:00Z') },
      logger,
    );

    await expect(service.runTargeted('run-id-must-not-be-logged')).rejects.toMatchObject({
      name: 'WorkerExecutionError',
      failure: {
        phase: 'DATABASE',
        errorCode: 'DATABASE_ERROR',
        errorClass: 'PRISMA_CLIENT_ERROR',
      },
    });
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
    await store.completeOnboarding(
      secondUser.id,
      'encrypted',
      'v1',
      'calendar-2',
      'openid email profile https://www.googleapis.com/auth/calendar.app.created',
    );
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
    await store.completeOnboarding(
      secondUser.id,
      'encrypted',
      'v1',
      'calendar-2',
      'openid email profile https://www.googleapis.com/auth/calendar.app.created',
    );
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

  it('deletes a 27-day-old channel without sending its old ID to YouTube', async () => {
    const store = new MemoryStore();
    const { user, channel, subscription } = await setup(store);
    const now = new Date('2026-07-30T00:00:00Z');
    channel.metadataFetchedAt = new Date(now.getTime() - 27 * 86_400_000);
    const youtube = new MutableYouTube();
    youtube.resolveChannelId = async () => {
      youtube.channelRefreshCalls += 1;
      throw new AppError('YOUTUBE_API_ERROR', 'failed', 502);
    };
    const service = new SyncService(store, youtube, new FakeCalendarGateway(), { now: () => now }, logger);
    await service.runScheduled();
    expect(youtube.channelRefreshCalls).toBe(0);
    expect(await store.findChannelById(channel.id)).toBeNull();
    expect(await store.getSubscription(user.id, subscription.id)).toBeNull();
    expect((await store.findUserById(user.id))?.channelReregistrationRequired).toBe(true);
    expect(youtube.upcomingCalls).toBe(0);
  });

  it('retries channel metadata refresh failures before the 22-day cleanup threshold', async () => {
    const store = new MemoryStore();
    const { user, channel, subscription } = await setup(store);
    const now = new Date('2026-07-30T00:00:00Z');
    channel.metadataFetchedAt = new Date(now.getTime() - 19 * 86_400_000);
    const youtube = new MutableYouTube();
    youtube.resolveChannelId = async () => {
      youtube.channelRefreshCalls += 1;
      throw new AppError('YOUTUBE_API_ERROR', 'failed', 502);
    };
    const service = new SyncService(store, youtube, new FakeCalendarGateway(), { now: () => now }, logger);
    await service.runScheduled();
    await service.runScheduled();
    expect(youtube.channelRefreshCalls).toBe(2);
    expect(await store.findChannelById(channel.id)).not.toBeNull();
    expect(await store.getSubscription(user.id, subscription.id)).not.toBeNull();
  });

  it('preserves Calendar deletion targets when expired broadcasts are purged and retries failures', async () => {
    const store = new MemoryStore();
    const { user, channel } = await setup(store);
    const observed = new Date('2026-07-01T00:00:00Z');
    const now = new Date('2026-07-30T00:00:00Z');
    channel.metadataFetchedAt = now;
    const [saved] = await store.upsertBroadcasts(channel.id, [broadcast()], observed);
    await store.saveMapping({ userId: user.id, broadcastId: saved!.id, eventId: 'event-stale', managedFieldsHash: 'hash' });
    const failed = new SyncService(store, new MutableYouTube(), new FailingDeleteCalendar(), { now: () => now }, logger);
    await failed.maintainYouTubeData(now);
    expect(await store.getMapping(user.id, saved!.id)).toBeNull();
    expect(await store.listBroadcastsForSync(channel.id, now, null)).toHaveLength(0);
    expect(await store.listPendingCalendarCleanup(100)).toMatchObject([{ eventId: 'event-stale' }]);
    const calendar = new FakeCalendarGateway();
    calendar.events.set('event-stale', { summary: 'old', description: 'old', start: now.toISOString(), end: now.toISOString(), status: 'confirmed', extendedProperties: { private: { managedBy: 'oshi-schedule' } } });
    await new SyncService(store, new MutableYouTube(), calendar, { now: () => now }, logger).maintainYouTubeData(now);
    expect(calendar.events.has('event-stale')).toBe(false);
    expect(await store.listPendingCalendarCleanup(100)).toHaveLength(0);
    expect(await store.getMapping(user.id, saved!.id)).toBeNull();
    await new SyncService(store, new MutableYouTube(), calendar, { now: () => now }, logger).maintainYouTubeData(now);
    expect(await store.listPendingCalendarCleanup(100)).toHaveLength(0);
  });

  it('purges API data before Calendar DELETE and retains the independent task until success', async () => {
    const store = new MemoryStore();
    const { user, channel } = await setup(store);
    const now = new Date('2026-07-30T00:00:00Z');
    channel.metadataFetchedAt = now;
    const [saved] = await store.upsertBroadcasts(channel.id, [broadcast()], new Date('2026-07-01T00:00:00Z'));
    await store.saveMapping({ userId: user.id, broadcastId: saved!.id, eventId: 'managed-old', managedFieldsHash: 'hash' });
    const calendar = new FakeCalendarGateway();
    calendar.events.set('managed-old', { summary: 'old', description: 'old', start: now.toISOString(), end: now.toISOString(), status: 'confirmed', extendedProperties: { private: { managedBy: 'oshi-schedule' } } });
    const order: string[] = [];
    const originalDelete = calendar.deleteEvent.bind(calendar);
    vi.spyOn(calendar, 'deleteEvent').mockImplementation(async (...args) => {
      expect(await store.getMapping(user.id, saved!.id)).toBeNull();
      expect(await store.listBroadcastsForSync(channel.id, now, null)).toHaveLength(0);
      expect(await store.listPendingCalendarCleanup(100)).toHaveLength(1);
      order.push('calendar');
      await originalDelete(...args);
    });
    const originalComplete = store.deleteCalendarCleanupTask.bind(store);
    vi.spyOn(store, 'deleteCalendarCleanupTask').mockImplementation(async (id) => {
      order.push('task');
      await originalComplete(id);
    });
    await new SyncService(store, new MutableYouTube(), calendar, { now: () => now }, logger).maintainYouTubeData(now);
    expect(order).toEqual(['calendar', 'task']);
    expect(await store.getMapping(user.id, saved!.id)).toBeNull();
    expect(await store.listPendingCalendarCleanup(100)).toHaveLength(0);
    expect(await store.listBroadcastsForSync(channel.id, now, null)).toHaveLength(0);
  });

  it('does not retry Calendar deletion with revoked credentials while removing expired API data', async () => {
    const store = new MemoryStore();
    const { user, channel } = await setup(store);
    const now = new Date('2026-07-30T00:00:00Z');
    channel.metadataFetchedAt = now;
    const [saved] = await store.upsertBroadcasts(channel.id, [broadcast()], new Date('2026-07-01T00:00:00Z'));
    await store.saveMapping({ userId: user.id, broadcastId: saved!.id, eventId: 'event-revoked', managedFieldsHash: 'hash' });
    await store.markReauthRequired(user.id);
    await new SyncService(store, new MutableYouTube(), new FailingDeleteCalendar(), { now: () => now }, logger).maintainYouTubeData(now);
    expect(await store.getMapping(user.id, saved!.id)).toBeNull();
    expect(await store.listPendingCalendarCleanup(100)).toHaveLength(0);
    expect(store.cleanupTasks).toMatchObject([{ eventId: 'event-revoked' }]);
    expect(await store.listBroadcastsForSync(channel.id, now, null)).toHaveLength(0);
    await store.completeOnboarding(user.id, 'new-encrypted', 'v1', 'calendar-sync', 'scopes');
    const calendar = new FakeCalendarGateway();
    calendar.events.set('event-revoked', { summary: 'old', description: 'old', start: now.toISOString(), end: now.toISOString(), status: 'confirmed', extendedProperties: { private: { managedBy: 'oshi-schedule' } } });
    await new SyncService(store, new MutableYouTube(), calendar, { now: () => now }, logger).maintainYouTubeData(now);
    expect(await store.getMapping(user.id, saved!.id)).toBeNull();
    expect(store.cleanupTasks).toHaveLength(0);
  });

  it.each(['decrypt', 'invalid_grant'] as const)('retains task but purges API data after %s credential failure', async (failure) => {
    const store = new MemoryStore();
    const { user, channel } = await setup(store);
    const now = new Date('2026-07-30T00:00:00Z');
    channel.metadataFetchedAt = now;
    const [saved] = await store.upsertBroadcasts(channel.id, [broadcast()], new Date('2026-07-01T00:00:00Z'));
    await store.saveMapping({ userId: user.id, broadcastId: saved!.id, eventId: 'credential-event', managedFieldsHash: 'hash' });
    const key = new AesTokenCipher(`v1:${Buffer.alloc(32, 5).toString('base64')}`);
    const encrypted = key.encrypt('refresh-token');
    await store.saveCredential(user.id, encrypted.ciphertext, encrypted.keyId, 'scope');
    const cipher = failure === 'decrypt'
      ? new AesTokenCipher(`v1:${Buffer.alloc(32, 6).toString('base64')}`)
      : key;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const calendar = new GoogleCalendarGateway(store, cipher, 'client', 'secret');
      await new SyncService(store, new MutableYouTube(), calendar, { now: () => now }, logger).maintainYouTubeData(now);
      expect(await store.getMapping(user.id, saved!.id)).toBeNull();
      expect(store.cleanupTasks).toMatchObject([{ eventId: 'credential-event' }]);
      expect(await store.listBroadcastsForSync(channel.id, now, null)).toHaveLength(0);
      expect((await store.findUserById(user.id))?.reauthRequired).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(failure === 'decrypt' ? 0 : 1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not discard Calendar mappings when a channel ID changes', async () => {
    const store = new MemoryStore();
    const { user, channel } = await setup(store);
    const [saved] = await store.upsertBroadcasts(channel.id, [broadcast()], start);
    await store.saveMapping({ userId: user.id, broadcastId: saved!.id, eventId: 'event-old-channel', managedFieldsHash: 'hash' });
    await expect(store.refreshChannel(channel.id, {
      id: 'new', youtubeChannelId: 'UC-new', title: 'New channel', handle: '@new', thumbnailUrl: 'new', channelUrl: 'new',
    }, new Date('2026-07-21T00:00:00Z'))).rejects.toMatchObject({ reason: 'CHANNEL_ID_CHANGED' });
    expect((await store.findChannelById(channel.id))?.youtubeChannelId).not.toBe('UC-new');
    expect(await store.getMapping(user.id, saved!.id)).not.toBeNull();
    expect(store.broadcasts).toHaveLength(1);
  });
});
