import { MANUAL_SYNC_COOLDOWN_SECONDS, SYNC_LOOKAHEAD_DAYS } from '@oshi-schedule/shared';
import { AppError } from '../domain/errors.js';
import { buildCalendarEvent, managedFieldsHash } from '../domain/scheduling.js';
import type { AppLogger, CalendarGateway, Clock, Store, YouTubeGateway } from './models.js';

const locks = new Set<string>();

export class SyncService {
  constructor(
    private readonly store: Store,
    private readonly youtube: YouTubeGateway,
    private readonly calendar: CalendarGateway,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
  ) {}

  async syncSubscription(userId: string, subscriptionId: string, manual = true) {
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
    if (locks.has(key)) throw new AppError('SYNC_ALREADY_RUNNING', '同期を実行中です', 409);
    locks.add(key);
    try {
      await this.store.saveSyncResult(
        subscriptionId,
        { status: 'SUCCESS', message: null },
        now,
        manual,
      );
      const fresh =
        target.channel.lastFetchedAt &&
        now.getTime() - target.channel.lastFetchedAt.getTime() <
          MANUAL_SYNC_COOLDOWN_SECONDS * 1000;
      if (!fresh) {
        const to = new Date(now.getTime() + SYNC_LOOKAHEAD_DAYS * 86_400_000);
        const items = await this.youtube.listUpcoming(target.channel, now, to);
        await this.store.upsertBroadcasts(target.channel.id, items);
        await this.store.updateChannelFetchedAt(target.channel.id, now);
      }
      const resolvedUser = await this.store.findUserById(target.subscription.userId);
      if (!resolvedUser) throw new AppError('USER_NOT_FOUND', '利用者が見つかりません', 404);
      const calendarId = await this.calendar.ensureCalendar(resolvedUser);
      const broadcasts = await this.store.listFutureBroadcasts(target.channel.id, now);
      for (const broadcast of broadcasts) {
        const event = buildCalendarEvent(broadcast, target.channel.title);
        const hash = managedFieldsHash(event);
        const mapping = await this.store.getMapping(resolvedUser.id, broadcast.id);
        if (mapping?.managedFieldsHash === hash) continue;
        const eventId = await this.calendar.upsertEvent(
          resolvedUser,
          calendarId,
          mapping?.eventId ?? null,
          event,
        );
        await this.store.saveMapping({
          userId: resolvedUser.id,
          broadcastId: broadcast.id,
          eventId,
          managedFieldsHash: hash,
        });
      }
      await this.store.saveSyncResult(
        subscriptionId,
        { status: 'SUCCESS', message: null },
        now,
        manual,
      );
      return { status: 'SUCCESS' as const, broadcasts: broadcasts.length };
    } catch (error) {
      this.logger.error(
        { code: error instanceof AppError ? error.code : 'SYNC_FAILED', subscriptionId },
        'subscription sync failed',
      );
      await this.store.saveSyncResult(
        subscriptionId,
        { status: 'FAILED', message: '同期に失敗しました' },
        now,
        manual,
      );
      throw error;
    } finally {
      locks.delete(key);
    }
  }

  async runScheduled() {
    const targets = await this.store.listActiveSubscriptions();
    const results: Array<{ subscriptionId: string; status: string }> = [];
    for (const target of targets) {
      try {
        await this.syncSubscription(target.user.id, target.subscription.id, false);
        results.push({ subscriptionId: target.subscription.id, status: 'SUCCESS' });
      } catch {
        results.push({ subscriptionId: target.subscription.id, status: 'FAILED' });
      }
    }
    return results;
  }
}
