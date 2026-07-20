import { MANUAL_SYNC_COOLDOWN_SECONDS, SYNC_LOOKAHEAD_DAYS } from '@oshi-schedule/shared';
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../domain/errors.js';
import { buildCalendarEvent, managedFieldsHash } from '../domain/scheduling.js';
import type { AppLogger, CalendarGateway, Clock, Store, YouTubeGateway } from './models.js';

const SYNC_LEASE_MILLISECONDS = 15 * 60_000;
const STALE_SYNC_RUN_MILLISECONDS = 24 * 60 * 60_000;
const SYNC_RUN_RETENTION_MILLISECONDS = 90 * 24 * 60 * 60_000;

const deterministicEventId = (userId: string, youtubeVideoId: string) =>
  `oshi${createHash('sha256').update(`${userId}:${youtubeVideoId}`).digest('hex')}`;

export class SyncService {
  constructor(
    private readonly store: Store,
    private readonly youtube: YouTubeGateway,
    private readonly calendar: CalendarGateway,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
  ) {}

  private async renewLease(key: string, ownerToken: string) {
    const now = this.clock.now();
    const renewed = await this.store.renewSyncLease(
      key,
      ownerToken,
      now,
      new Date(now.getTime() + SYNC_LEASE_MILLISECONDS),
    );
    if (!renewed) throw new AppError('SYNC_LEASE_LOST', '同期の排他権を失いました', 409, true);
  }

  async syncSubscription(
    userId: string,
    subscriptionId: string,
    manual = true,
    existingRunId?: string,
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
    const runId = existingRunId ?? (await this.store.startSyncRun('MANUAL', userId, 1, now));
    await this.store.startSyncTarget(runId, subscriptionId, now);
    const acquired = await this.store.acquireSyncLease(
      key,
      ownerToken,
      now,
      new Date(now.getTime() + SYNC_LEASE_MILLISECONDS),
    );
    if (!acquired) {
      const result = {
        status: 'FAILED' as const,
        message: '同期を実行中です',
        errorCode: 'SYNC_ALREADY_RUNNING',
      };
      await this.store.finishSyncTarget(runId, subscriptionId, result, now);
      if (!existingRunId)
        await this.store.finishSyncRun(runId, 'FAILED', now, 'SYNC_ALREADY_RUNNING');
      throw new AppError('SYNC_ALREADY_RUNNING', '同期を実行中です', 409);
    }
    try {
      await this.store.saveSyncResult(
        subscriptionId,
        { status: 'RUNNING', message: null },
        now,
        manual,
      );
      const fresh =
        target.channel.lastFetchedAt &&
        now.getTime() - target.channel.lastFetchedAt.getTime() <
          MANUAL_SYNC_COOLDOWN_SECONDS * 1000;
      if (!fresh) {
        const to = new Date(now.getTime() + SYNC_LOOKAHEAD_DAYS * 86_400_000);
        const upcoming = await this.youtube.listUpcoming(target.channel, now, to);
        const tracked = await this.store.listTrackableBroadcasts(target.channel.id, now);
        const refreshed = await this.youtube.refreshBroadcasts(
          target.channel,
          tracked.map((item) => item.youtubeVideoId),
        );
        const merged = new Map(
          [...upcoming, ...refreshed.items].map((item) => [item.youtubeVideoId, item]),
        );
        await this.store.upsertBroadcasts(target.channel.id, [...merged.values()], now);
        await this.store.markBroadcastsUnavailable(
          target.channel.id,
          refreshed.unavailableVideoIds,
          now,
        );
        await this.store.updateChannelFetchedAt(target.channel.id, now);
      }
      await this.renewLease(key, ownerToken);
      const resolvedUser = await this.store.findUserById(target.subscription.userId);
      if (!resolvedUser) throw new AppError('USER_NOT_FOUND', '利用者が見つかりません', 404);
      if (resolvedUser.reauthRequired)
        throw new AppError('GOOGLE_REAUTH_REQUIRED', 'Googleの再連携が必要です', 401);
      const calendarId = await this.calendar.ensureCalendar(resolvedUser);
      const broadcasts = await this.store.listBroadcastsForSync(
        target.channel.id,
        now,
        target.subscription.lastCalendarSyncAt,
      );
      for (const broadcast of broadcasts) {
        await this.renewLease(key, ownerToken);
        const event = buildCalendarEvent(broadcast, target.channel.title);
        const hash = managedFieldsHash(event);
        const mapping = await this.store.getMapping(resolvedUser.id, broadcast.id);
        if (broadcast.status === 'CANCELLED' && !mapping) continue;
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
        await this.store.saveMapping({
          userId: resolvedUser.id,
          broadcastId: broadcast.id,
          eventId: savedEventId,
          managedFieldsHash: hash,
        });
      }
      await this.store.saveSyncResult(
        subscriptionId,
        { status: 'SUCCESS', message: null },
        now,
        manual,
      );
      await this.store.finishSyncTarget(
        runId,
        subscriptionId,
        { status: 'SUCCESS', message: null },
        now,
      );
      if (!existingRunId) await this.store.finishSyncRun(runId, 'SUCCESS', now);
      return { status: 'SUCCESS' as const, broadcasts: broadcasts.length };
    } catch (error) {
      this.logger.error(
        { code: error instanceof AppError ? error.code : 'SYNC_FAILED', subscriptionId },
        'subscription sync failed',
      );
      await this.store.saveSyncResult(
        subscriptionId,
        {
          status: 'FAILED',
          message: '同期に失敗しました',
          errorCode: error instanceof AppError ? error.code : 'SYNC_FAILED',
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
        },
        now,
      );
      if (!existingRunId)
        await this.store.finishSyncRun(
          runId,
          'FAILED',
          now,
          error instanceof AppError ? error.code : 'SYNC_FAILED',
        );
      throw error;
    } finally {
      await this.store.releaseSyncLease(key, ownerToken);
    }
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
        await this.syncSubscription(target.user.id, target.subscription.id, false, runId);
        results.push({ subscriptionId: target.subscription.id, status: 'SUCCESS' });
      } catch {
        results.push({ subscriptionId: target.subscription.id, status: 'FAILED' });
      }
    }
    const failed = results.filter((result) => result.status === 'FAILED').length;
    await this.store.finishSyncRun(
      runId,
      failed === 0 ? 'SUCCESS' : failed === results.length ? 'FAILED' : 'PARTIAL_FAILED',
      this.clock.now(),
      failed ? 'SYNC_TARGET_FAILED' : undefined,
    );
    return results;
  }
}
