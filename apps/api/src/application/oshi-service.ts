import { MAX_CHANNELS_PER_USER } from '@oshi-schedule/shared';
import { randomUUID } from 'node:crypto';
import { AppError, StoreConstraintError } from '../domain/errors.js';
import type {
  AuthAdmin,
  AuthIdentity,
  CalendarGateway,
  Clock,
  Store,
  SyncJobDispatcher,
  TokenCipher,
  YouTubeGateway,
} from './models.js';
import type { SyncService } from './sync-service.js';

export class OshiService {
  constructor(
    private readonly store: Store,
    private readonly youtube: YouTubeGateway,
    private readonly calendar: CalendarGateway,
    private readonly cipher: TokenCipher,
    private readonly clock: Clock,
    private readonly authAdmin: AuthAdmin,
    readonly sync: SyncService,
    private readonly dispatcher: SyncJobDispatcher,
    private readonly accountDeletionLeaseMs = 60_000,
  ) {}

  private async requireActiveUser(identity: AuthIdentity) {
    if (await this.store.findAccountDeletion(identity.subject))
      throw new AppError(
        'ACCOUNT_DELETION_IN_PROGRESS',
        'アカウント削除処理中のため利用できません',
        410,
      );
    const user = await this.store.findUserBySubject(identity.subject);
    if (!user) throw new AppError('ONBOARDING_REQUIRED', '初回設定を完了してください', 409);
    return user;
  }

  async me(identity: AuthIdentity) {
    return this.requireActiveUser(identity);
  }

  async onboard(identity: AuthIdentity, refreshToken: string) {
    if (await this.store.findAccountDeletion(identity.subject))
      throw new AppError('ACCOUNT_DELETED', '削除済みのアカウントです', 410);
    const user = await this.store.ensureUser(identity);
    const encrypted = this.cipher.encrypt(refreshToken);
    await this.store.saveCredential(user.id, encrypted.ciphertext, encrypted.keyId);
    const calendarId = await this.calendar.ensureCalendar(user);
    return this.store.completeOnboarding(
      user.id,
      encrypted.ciphertext,
      encrypted.keyId,
      calendarId,
    );
  }

  async resolve(identity: AuthIdentity, handle: string) {
    await this.requireActiveUser(identity);
    const resolved = await this.youtube.resolveHandle(handle);
    return this.store.upsertChannel(resolved);
  }

  async list(identity: AuthIdentity) {
    const user = await this.requireActiveUser(identity);
    return this.store.listSubscriptions(user.id);
  }

  async register(identity: AuthIdentity, youtubeChannelId: string) {
    const user = await this.requireActiveUser(identity);
    const channel = await this.store.findChannelByYoutubeId(youtubeChannelId);
    if (!channel)
      throw new AppError('CHANNEL_NOT_RESOLVED', '先にチャンネルを検索してください', 409);
    try {
      return await this.store.createSubscriptionWithinLimit(
        user.id,
        channel.id,
        MAX_CHANNELS_PER_USER,
      );
    } catch (error) {
      if (error instanceof StoreConstraintError && error.reason === 'CHANNEL_LIMIT')
        throw new AppError('CHANNEL_LIMIT_REACHED', '登録上限は3件です', 422);
      if (error instanceof StoreConstraintError && error.reason === 'DUPLICATE_CHANNEL')
        throw new AppError('DUPLICATE_CHANNEL', 'このチャンネルは登録済みです', 409);
      throw error;
    }
  }

  async registerAndSync(identity: AuthIdentity, youtubeChannelId: string) {
    const subscription = await this.register(identity, youtubeChannelId);
    const queued = await this.sync.queueSubscription(subscription.userId, subscription.id, true);
    const dispatched = !queued.created || (await this.dispatch(queued.run));
    return {
      subscription: { id: subscription.id, status: subscription.status },
      sync: {
        id: queued.run.id,
        subscriptionId: subscription.id,
        status: dispatched
          ? queued.run.status === 'RUNNING'
            ? ('RUNNING' as const)
            : ('QUEUED' as const)
          : ('FAILED' as const),
        ...(!dispatched ? { errorCode: 'SYNC_DISPATCH_FAILED' } : {}),
      },
    };
  }

  private async dispatch(run: Awaited<ReturnType<Store['enqueueSyncRun']>>['run']) {
    if (run.status !== 'QUEUED') return true;
    try {
      await this.dispatcher.dispatch(run.id);
      return true;
    } catch {
      const at = this.clock.now();
      const result = {
        status: 'FAILED' as const,
        message: '同期ジョブを開始できませんでした',
        errorCode: 'SYNC_DISPATCH_FAILED',
      };
      await this.store.saveSyncResult(run.subscriptionId, result, at, false);
      await this.store.finishSyncTarget(run.id, run.subscriptionId, result, at);
      await this.store.finishSyncRun(run.id, 'FAILED', at, 'SYNC_DISPATCH_FAILED');
      return false;
    }
  }

  async requestSync(identity: AuthIdentity, subscriptionId: string) {
    const user = await this.requireActiveUser(identity);
    const queued = await this.sync.queueSubscription(user.id, subscriptionId);
    if (queued.created && !(await this.dispatch(queued.run)))
      throw new AppError(
        'SYNC_DISPATCH_FAILED',
        '同期ジョブを開始できませんでした。もう一度お試しください',
        503,
        true,
      );
    return {
      id: queued.run.id,
      subscriptionId: queued.run.subscriptionId,
      status: queued.run.status === 'RUNNING' ? ('RUNNING' as const) : ('QUEUED' as const),
    };
  }

  async syncRun(identity: AuthIdentity, syncRunId: string) {
    const user = await this.requireActiveUser(identity);
    const run = await this.store.getSyncRunForUser(syncRunId, user.id);
    if (!run) throw new AppError('NOT_FOUND', '対象が見つかりません', 404);
    return {
      id: run.id,
      subscriptionId: run.subscriptionId,
      trigger: run.type,
      status: run.status,
      queuedAt: run.queuedAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.completedAt?.toISOString() ?? null,
      error: run.errorCode ? { code: run.errorCode, message: run.errorMessage } : null,
      result: {
        youtubeFetch: run.youtubeFetchStatus,
        databaseUpdate: run.databaseUpdateStatus,
        calendarSync: run.calendarSyncStatus,
        snapshotVersion: run.snapshotVersion,
      },
    };
  }

  async setStatus(identity: AuthIdentity, id: string, status: 'ACTIVE' | 'PAUSED') {
    const user = await this.requireActiveUser(identity);
    const result = await this.store.updateSubscription(user.id, id, status);
    if (!result) throw new AppError('NOT_FOUND', '対象が見つかりません', 404);
    return result;
  }

  async remove(identity: AuthIdentity, id: string) {
    const user = await this.requireActiveUser(identity);
    const target = await this.store.getSubscription(user.id, id);
    if (!target) throw new AppError('NOT_FOUND', '対象が見つかりません', 404);
    if (user.calendarId) {
      const broadcasts = await this.store.listFutureBroadcasts(target.channel.id, this.clock.now());
      for (const item of broadcasts) {
        const mapping = await this.store.getMapping(user.id, item.id);
        if (mapping) {
          await this.calendar.deleteEvent(user, user.calendarId, mapping.eventId);
          await this.store.deleteMapping(user.id, item.id);
        }
      }
    }
    await this.store.deleteSubscription(user.id, id);
  }

  async reconnect(identity: AuthIdentity, refreshToken: string) {
    return this.onboard(identity, refreshToken);
  }

  async deleteAccount(identity: AuthIdentity) {
    let deletion = await this.store.findAccountDeletion(identity.subject);
    let user = await this.store.findUserBySubject(identity.subject);
    if (!deletion) {
      if (!user) throw new AppError('NOT_FOUND', '対象が見つかりません', 404);
      deletion = await this.store.beginAccountDeletion(user);
    }
    const leaseKey = `account-deletion:${identity.subject}`;
    const ownerToken = randomUUID();
    const leaseAt = this.clock.now();
    const acquired = await this.store.acquireSyncLease(
      leaseKey,
      ownerToken,
      leaseAt,
      this.accountDeletionLeaseMs,
    );
    if (!acquired)
      throw new AppError('ACCOUNT_DELETION_IN_PROGRESS', 'アカウント削除処理中です', 409, true);
    const renewLease = async () => {
      const at = this.clock.now();
      if (!(await this.store.renewSyncLease(acquired, at, this.accountDeletionLeaseMs)))
        throw new AppError(
          'ACCOUNT_DELETION_LEASE_LOST',
          '削除処理の排他権を失いました',
          409,
          true,
        );
    };
    const markStep = async (step: Parameters<Store['markAccountDeletionStep']>[1], at: Date) => {
      if (!(await this.store.markAccountDeletionStep(deletion.id, step, at, acquired)))
        throw new AppError(
          'ACCOUNT_DELETION_LEASE_LOST',
          '削除処理の排他権を失いました',
          409,
          true,
        );
    };
    const now = () => this.clock.now();
    try {
      if (!deletion.calendarDeletedAt) {
        await renewLease();
        if (user && deletion.calendarIdSnapshot) {
          try {
            await this.calendar.deleteCalendar(user, deletion.calendarIdSnapshot);
          } catch (error) {
            if (!(error instanceof AppError) || error.code !== 'GOOGLE_REAUTH_REQUIRED')
              throw error;
          }
        }
        await renewLease();
        const at = now();
        await markStep('CALENDAR_DELETED', at);
        deletion.calendarDeletedAt = at;
      }
      if (!deletion.googleTokenRevokedAt) {
        await renewLease();
        if (user) await this.calendar.revokeAuthorization(user);
        await renewLease();
        const at = now();
        await markStep('TOKEN_REVOKED', at);
        deletion.googleTokenRevokedAt = at;
      }
      if (!deletion.userDataDeletedAt) {
        await renewLease();
        const at = now();
        if (
          deletion.userId &&
          !(await this.store.deleteUserData(deletion.id, deletion.userId, at, acquired))
        )
          throw new AppError(
            'ACCOUNT_DELETION_LEASE_LOST',
            '削除処理の排他権を失いました',
            409,
            true,
          );
        if (!deletion.userId) await markStep('DATA_DELETED', at);
        deletion.userDataDeletedAt = at;
        user = null;
      }
      if (!deletion.supabaseUserDeletedAt) {
        await renewLease();
        await this.authAdmin.deleteUser(identity.subject);
        await renewLease();
        const at = now();
        await markStep('AUTH_DELETED', at);
        deletion.supabaseUserDeletedAt = at;
      }
      if (!deletion.completedAt) await markStep('COMPLETED', now());
    } catch (error) {
      await this.store.markAccountDeletionFailed(
        deletion.id,
        error instanceof AppError ? error.code : 'ACCOUNT_DELETE_FAILED',
        now(),
        acquired,
      );
      throw error;
    } finally {
      await this.store.releaseSyncLease(acquired);
    }
  }
}
