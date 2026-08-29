import { MANUAL_SYNC_COOLDOWN_SECONDS, SYNC_LOOKAHEAD_DAYS } from '@oshi-schedule/shared';
import { createHash, randomUUID } from 'node:crypto';
import { AppError, StoreConstraintError, WorkerExecutionError } from '../domain/errors.js';
import {
  buildCalendarEvent,
  managedFieldsHash,
  shouldSyncCalendarEvent,
} from '../domain/scheduling.js';
import type {
  AppLogger,
  CalendarGateway,
  Clock,
  LeaseOwnership,
  Store,
  SyncPhaseStatus,
  SyncResult,
  YouTubeGateway,
  YouTubeQuotaMode,
} from './models.js';

const STALE_SYNC_RUN_MILLISECONDS = 24 * 60 * 60_000;
const SYNC_RUN_RETENTION_MILLISECONDS = 90 * 24 * 60 * 60_000;
const TARGETED_RUN_STALE_MILLISECONDS = 30 * 60_000;

const deterministicEventId = (userId: string, youtubeVideoId: string) =>
  `oshi${createHash('sha256').update(`${userId}:${youtubeVideoId}`).digest('hex')}`;

export class SyncService {
  constructor(
    private readonly store: Store,
    private readonly youtube: YouTubeGateway,
    private readonly calendar: CalendarGateway,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
    private readonly syncLeaseMs = 15 * 60_000,
    private readonly fetchConfig = {
      maxTrackedBroadcastsPerChannel: 50,
      trackingWindowDays: 30,
      snapshotWaitMs: 30_000,
      snapshotPollMs: 50,
    },
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  private async renewLease(lease: LeaseOwnership, runId?: string) {
    const now = this.clock.now();
    const renewed = await this.store.renewSyncLease(lease, now, this.syncLeaseMs);
    if (!renewed) throw new AppError('SYNC_LEASE_LOST', '同期の排他権を失いました', 409, true);
    if (runId) await this.store.heartbeatSyncRun(runId, now);
  }

  async queueSubscription(userId: string, subscriptionId: string, initial = false) {
    const target = await this.store.getSubscription(userId, subscriptionId);
    if (!target) throw new AppError('NOT_FOUND', '対象が見つかりません', 404);
    if (target.subscription.status === 'PAUSED')
      throw new AppError('SUBSCRIPTION_PAUSED', '一時停止中です', 409);
    const now = this.clock.now();
    try {
      return await this.store.enqueueSyncRun(
        userId,
        subscriptionId,
        now,
        new Date(now.getTime() - MANUAL_SYNC_COOLDOWN_SECONDS * 1_000),
        initial ? 'INITIAL' : 'MANUAL',
      );
    } catch (error) {
      if (error instanceof StoreConstraintError && error.reason === 'SYNC_COOLDOWN')
        throw new AppError('SYNC_COOLDOWN', '前回の同期から5分後に再実行できます', 429);
      if (error instanceof StoreConstraintError && error.reason === 'SUBSCRIPTION_NOT_FOUND')
        throw new AppError('NOT_FOUND', '対象が見つかりません', 404);
      throw error;
    }
  }

  async runTargeted(runId: string) {
    const now = this.clock.now();
    let run;
    try {
      run = await this.store.claimSyncRun(
        runId,
        now,
        new Date(now.getTime() - TARGETED_RUN_STALE_MILLISECONDS),
      );
    } catch (error) {
      throw new WorkerExecutionError('SYNC_RUN_CLAIM', error);
    }
    if (!run) return { status: 'SKIPPED' as const };
    try {
      return await this.syncSubscription(
        run.requestedById,
        run.subscriptionId,
        run.type === 'MANUAL',
        run.id,
        'MANUAL',
        true,
      );
    } catch (error) {
      let latest;
      try {
        latest = await this.store.getSyncRunForUser(run.id, run.requestedById);
      } catch (finalizationError) {
        throw new WorkerExecutionError('DATABASE', finalizationError);
      }
      if (latest?.status === 'RUNNING') {
        const errorCode = error instanceof AppError ? error.code : 'SYNC_FAILED';
        try {
          await this.store.finishSyncTarget(
            run.id,
            run.subscriptionId,
            { status: 'FAILED', message: '同期に失敗しました', errorCode },
            this.clock.now(),
          );
          await this.store.finishSyncRun(run.id, 'FAILED', this.clock.now(), errorCode);
        } catch (finalizationError) {
          throw new WorkerExecutionError('DATABASE', finalizationError);
        }
      }
      throw new WorkerExecutionError('SYNC_EXECUTION', error);
    }
  }

  async runPendingManual(limit = 10) {
    const now = this.clock.now();
    const runIds = await this.store.listRecoverableSyncRunIds(
      new Date(now.getTime() - TARGETED_RUN_STALE_MILLISECONDS),
      limit,
    );
    const results: Array<{ status: string }> = [];
    for (const runId of runIds) {
      try {
        results.push(await this.runTargeted(runId));
      } catch {
        results.push({ status: 'FAILED' });
      }
    }
    return results;
  }

  private channelIsFresh(channel: Awaited<ReturnType<Store['findChannelById']>>, now: Date) {
    const succeededAt = channel?.lastFetchSucceededAt ?? channel?.lastFetchedAt;
    return Boolean(
      succeededAt && now.getTime() - succeededAt.getTime() < MANUAL_SYNC_COOLDOWN_SECONDS * 1000,
    );
  }

  private async waitForSnapshot(channelId: string, baselineVersion: number, now: Date) {
    let elapsed = 0;
    while (elapsed <= this.fetchConfig.snapshotWaitMs) {
      const channel = await this.store.findChannelById(channelId);
      if (
        channel &&
        channel.snapshotVersion > baselineVersion &&
        this.channelIsFresh(channel, now) &&
        channel.lastFetchStatus === 'SUCCESS'
      )
        return channel;
      if (elapsed >= this.fetchConfig.snapshotWaitMs) break;
      const delay = Math.min(
        this.fetchConfig.snapshotPollMs,
        this.fetchConfig.snapshotWaitMs - elapsed,
      );
      await this.sleep(delay);
      elapsed += delay;
    }
    return null;
  }

  async syncSubscription(
    userId: string,
    subscriptionId: string,
    manual = true,
    existingRunId?: string,
    quotaMode: YouTubeQuotaMode = manual ? 'MANUAL' : 'SCHEDULED',
    finishExistingRun = false,
  ) {
    const target = await this.store.getSubscription(userId, subscriptionId);
    if (!target) throw new AppError('NOT_FOUND', '対象が見つかりません', 404);
    if (target.subscription.status === 'PAUSED')
      throw new AppError('SUBSCRIPTION_PAUSED', '一時停止中です', 409);
    const now = this.clock.now();
    if (
      manual &&
      target.subscription.lastManualSyncAt &&
      now.getTime() - target.subscription.lastManualSyncAt.getTime() <
        MANUAL_SYNC_COOLDOWN_SECONDS * 1000
    ) {
      throw new AppError('SYNC_COOLDOWN', '前回の同期から5分後に再実行できます', 429);
    }
    const key = `subscription:${subscriptionId}`;
    const ownerToken = randomUUID();
    const runId = existingRunId ?? (await this.store.startSyncRun(quotaMode, userId, 1, now));
    await this.store.startSyncTarget(runId, subscriptionId, now);
    const acquired = await this.store.acquireSyncLease(key, ownerToken, now, this.syncLeaseMs);
    if (!acquired) {
      const result = {
        status: 'FAILED' as const,
        message: '同期を実行中です',
        errorCode: 'SYNC_ALREADY_RUNNING',
      };
      await this.store.finishSyncTarget(runId, subscriptionId, result, now);
      if (!existingRunId || finishExistingRun)
        await this.store.finishSyncRun(runId, 'FAILED', now, 'SYNC_ALREADY_RUNNING');
      throw new AppError('SYNC_ALREADY_RUNNING', '同期を実行中です', 409);
    }
    let fetchDeferred: AppError | null = null;
    let snapshotVersion = target.channel.snapshotVersion;
    const phases: {
      youtubeFetch: SyncPhaseStatus;
      databaseUpdate: SyncPhaseStatus;
      calendarSync: SyncPhaseStatus;
    } = { youtubeFetch: 'NOT_STARTED', databaseUpdate: 'NOT_STARTED', calendarSync: 'NOT_STARTED' };
    let calendarStarted = false;
    try {
      await this.store.saveSyncResult(
        subscriptionId,
        { status: 'RUNNING', message: null },
        now,
        manual,
      );
      let fresh = this.channelIsFresh(target.channel, now);
      if (fresh) {
        phases.youtubeFetch = 'SKIPPED';
        phases.databaseUpdate = 'SKIPPED';
      }
      if (!fresh) {
        const channelLease = await this.store.acquireSyncLease(
          `youtube-channel:${target.channel.id}`,
          randomUUID(),
          this.clock.now(),
          this.syncLeaseMs,
        );
        if (channelLease) {
          try {
            const latestChannel = await this.store.findChannelById(target.channel.id);
            fresh = this.channelIsFresh(latestChannel, now);
            if (!fresh) {
              if (!(await this.store.startChannelFetch(target.channel.id, now, channelLease)))
                throw new AppError('SYNC_LEASE_LOST', 'YouTube取得の排他権を失いました', 409, true);
              const context = {
                mode: quotaMode,
                runId,
              };
              try {
                const to = new Date(now.getTime() + SYNC_LOOKAHEAD_DAYS * 86_400_000);
                const channel = latestChannel ?? target.channel;
                const upcoming = await this.youtube.listUpcoming(channel, now, to, context);
                const tracked = await this.store.listTrackableBroadcasts(
                  channel.id,
                  now,
                  this.fetchConfig.maxTrackedBroadcastsPerChannel,
                  this.fetchConfig.trackingWindowDays,
                );
                const refreshed = await this.youtube.refreshBroadcasts(
                  channel,
                  tracked.map((item) => item.youtubeVideoId),
                  context,
                );
                if (
                  !(await this.store.renewSyncLease(
                    channelLease,
                    this.clock.now(),
                    this.syncLeaseMs,
                  ))
                )
                  throw new AppError(
                    'SYNC_LEASE_LOST',
                    'YouTube取得の排他権を失いました',
                    409,
                    true,
                  );
                await this.renewLease(acquired, runId);
                const merged = new Map(
                  [...upcoming, ...refreshed.items].map((item) => [item.youtubeVideoId, item]),
                );
                const committedVersion = await this.store.commitChannelSnapshot(
                  channel.id,
                  [...merged.values()],
                  refreshed.unavailableVideoIds,
                  now,
                  channelLease,
                );
                if (committedVersion === null)
                  throw new AppError(
                    'SYNC_LEASE_LOST',
                    'YouTube取得の排他権を失いました',
                    409,
                    true,
                  );
                snapshotVersion = committedVersion;
                phases.youtubeFetch = 'SUCCESS';
                phases.databaseUpdate = 'SUCCESS';
              } catch (error) {
                if (!(error instanceof AppError) || error.code !== 'YOUTUBE_QUOTA_DEFERRED') {
                  phases.youtubeFetch = 'FAILED';
                  phases.databaseUpdate = 'FAILED';
                  await this.store.finishChannelFetch(
                    target.channel.id,
                    'FAILED',
                    this.clock.now(),
                    null,
                    channelLease,
                  );
                  throw error;
                }
                fetchDeferred = error;
                phases.youtubeFetch = 'DEFERRED';
                phases.databaseUpdate = 'SKIPPED';
                const nextRetryAt = error.details?.nextRetryAt
                  ? new Date(String(error.details.nextRetryAt))
                  : null;
                await this.store.finishChannelFetch(
                  target.channel.id,
                  'DEFERRED',
                  this.clock.now(),
                  nextRetryAt,
                  channelLease,
                );
                this.logger.info(
                  {
                    runId,
                    subscriptionId,
                    errorCode: error.code,
                    nextRetryAt: error.details?.nextRetryAt,
                  },
                  'YouTube refresh deferred; using cached broadcasts',
                );
              }
            } else {
              snapshotVersion = latestChannel?.snapshotVersion ?? snapshotVersion;
              phases.youtubeFetch = 'SKIPPED';
              phases.databaseUpdate = 'SKIPPED';
            }
          } finally {
            await this.store.releaseSyncLease(channelLease);
          }
        } else {
          const completed = await this.waitForSnapshot(
            target.channel.id,
            target.channel.snapshotVersion,
            now,
          );
          if (completed) {
            snapshotVersion = completed.snapshotVersion;
            phases.youtubeFetch = 'SKIPPED';
            phases.databaseUpdate = 'SKIPPED';
          } else {
            const latest = await this.store.findChannelById(target.channel.id);
            const nextRetryAt =
              latest?.nextFetchAt ??
              new Date(now.getTime() + Math.max(1_000, this.fetchConfig.snapshotPollMs));
            fetchDeferred = new AppError(
              'YOUTUBE_FETCH_DEFERRED',
              'YouTube情報の取得完了を待って再実行します',
              409,
              true,
              { nextRetryAt: nextRetryAt.toISOString() },
            );
            phases.youtubeFetch = 'DEFERRED';
            phases.databaseUpdate = 'SKIPPED';
          }
        }
      }
      await this.renewLease(acquired, runId);
      const resolvedUser = await this.store.findUserById(target.subscription.userId);
      if (!resolvedUser) throw new AppError('USER_NOT_FOUND', '利用者が見つかりません', 404);
      if (resolvedUser.reauthRequired)
        throw new AppError('GOOGLE_REAUTH_REQUIRED', 'Googleの再連携が必要です', 401);
      calendarStarted = true;
      const calendarId = await this.calendar.ensureCalendar(resolvedUser);
      await this.renewLease(acquired, runId);
      const broadcasts = await this.store.listBroadcastsForSync(
        target.channel.id,
        now,
        target.subscription.lastCalendarSyncAt,
      );
      for (const broadcast of broadcasts) {
        await this.renewLease(acquired, runId);
        const event = buildCalendarEvent(broadcast, target.channel.title);
        const hash = managedFieldsHash(event);
        const mapping = await this.store.getMapping(resolvedUser.id, broadcast.id);
        if (!shouldSyncCalendarEvent(broadcast, Boolean(mapping), now)) continue;
        if (
          mapping?.managedFieldsHash === hash &&
          (await this.calendar.eventExists(resolvedUser, calendarId, mapping.eventId))
        )
          continue;
        const eventId =
          mapping?.eventId ?? deterministicEventId(resolvedUser.id, broadcast.youtubeVideoId);
        const savedEventId = await this.calendar.upsertEvent(
          resolvedUser,
          calendarId,
          eventId,
          event,
          !mapping,
        );
        await this.renewLease(acquired, runId);
        await this.store.saveMapping({
          userId: resolvedUser.id,
          broadcastId: broadcast.id,
          eventId: savedEventId,
          managedFieldsHash: hash,
        });
      }
      phases.calendarSync = 'SUCCESS';
      const result: SyncResult = fetchDeferred
        ? {
            status: 'DEFERRED' as const,
            message: 'YouTube情報の更新を延期し、保存済みデータを同期しました',
            errorCode: fetchDeferred.code,
            phases,
            snapshotVersion,
          }
        : { status: 'SUCCESS' as const, message: null, phases, snapshotVersion };
      await this.renewLease(acquired, runId);
      await this.store.saveSyncResult(subscriptionId, result, now, manual);
      await this.store.finishSyncTarget(runId, subscriptionId, result, now);
      if (!existingRunId || finishExistingRun)
        await this.store.finishSyncRun(runId, fetchDeferred ? 'DEFERRED' : 'SUCCESS', now);
      return {
        status: fetchDeferred ? ('DEFERRED' as const) : ('SUCCESS' as const),
        broadcasts: broadcasts.length,
        snapshotVersion,
        phases,
        ...(fetchDeferred ? { nextRetryAt: fetchDeferred.details?.nextRetryAt } : {}),
      };
    } catch (error) {
      if (calendarStarted && phases.calendarSync !== 'SUCCESS') phases.calendarSync = 'FAILED';
      this.logger.error(
        {
          errorCode: error instanceof AppError ? error.code : 'SYNC_FAILED',
          subscriptionId,
          runId,
        },
        'subscription sync failed',
      );
      if (!(error instanceof AppError) || error.code !== 'SYNC_LEASE_LOST')
        await this.store.saveSyncResult(
          subscriptionId,
          {
            status: 'FAILED',
            message: '同期に失敗しました',
            errorCode: error instanceof AppError ? error.code : 'SYNC_FAILED',
            phases,
            snapshotVersion,
          },
          now,
          manual,
        );
      await this.store.finishSyncTarget(
        runId,
        subscriptionId,
        {
          status: 'FAILED',
          message: '同期に失敗しました',
          errorCode: error instanceof AppError ? error.code : 'SYNC_FAILED',
          phases,
          snapshotVersion,
        },
        now,
      );
      if (!existingRunId || finishExistingRun)
        await this.store.finishSyncRun(
          runId,
          'FAILED',
          now,
          error instanceof AppError ? error.code : 'SYNC_FAILED',
        );
      throw error;
    } finally {
      await this.store.releaseSyncLease(acquired);
    }
  }

  async syncInitialSubscription(userId: string, subscriptionId: string) {
    return this.syncSubscription(userId, subscriptionId, false, undefined, 'MANUAL');
  }

  async runScheduled() {
    const now = this.clock.now();
    await this.store.maintainSyncRuns(
      new Date(now.getTime() - STALE_SYNC_RUN_MILLISECONDS),
      new Date(now.getTime() - SYNC_RUN_RETENTION_MILLISECONDS),
      now,
    );
    const targets = await this.store.listActiveSubscriptions();
    const runId = await this.store.startSyncRun('SCHEDULED', null, targets.length, now);
    const results: Array<{ subscriptionId: string; status: string }> = [];
    for (const target of targets) {
      try {
        const result = await this.syncSubscription(
          target.user.id,
          target.subscription.id,
          false,
          runId,
        );
        results.push({ subscriptionId: target.subscription.id, status: result.status });
      } catch {
        results.push({ subscriptionId: target.subscription.id, status: 'FAILED' });
      }
    }
    const failed = results.filter((result) => result.status === 'FAILED').length;
    const deferred = results.filter((result) => result.status === 'DEFERRED').length;
    await this.store.finishSyncRun(
      runId,
      results.length === 0
        ? 'SUCCESS'
        : failed === results.length
          ? 'FAILED'
          : failed > 0
            ? 'PARTIAL_FAILED'
            : deferred === results.length && deferred > 0
              ? 'DEFERRED'
              : deferred > 0
                ? 'PARTIAL_SUCCESS'
                : 'SUCCESS',
      this.clock.now(),
      failed ? 'SYNC_TARGET_FAILED' : undefined,
    );
    return results;
  }
}
