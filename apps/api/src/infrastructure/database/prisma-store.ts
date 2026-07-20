import { Prisma, PrismaClient } from '@prisma/client';
import type { ChannelSummary, SubscriptionStatus } from '@oshi-schedule/shared';
import type {
  AuthIdentity,
  MappingRecord,
  Store,
  SubscriptionRecord,
  SyncResult,
} from '../../application/models.js';
import type { NormalizedBroadcast } from '../../domain/scheduling.js';
import { StoreConstraintError } from '../../domain/errors.js';

const toUser = (row: {
  id: string;
  supabaseUserId: string;
  email: string;
  onboardingCompletedAt: Date | null;
  reauthRequired: boolean;
  calendar?: { googleCalendarId: string | null } | null;
}) => ({
  id: row.id,
  subject: row.supabaseUserId,
  email: row.email,
  onboardingCompleted: Boolean(row.onboardingCompletedAt),
  reauthRequired: row.reauthRequired,
  calendarId: row.calendar?.googleCalendarId ?? null,
});
const toChannel = (row: {
  id: string;
  youtubeChannelId: string;
  title: string;
  handle: string;
  thumbnailUrl: string;
  channelUrl: string;
  lastFetchedAt: Date | null;
}) => ({ ...row });
const toSubscription = (row: {
  id: string;
  userId: string;
  channelId: string;
  status: SubscriptionStatus;
  lastCalendarSyncAt: Date | null;
  lastManualSyncAt: Date | null;
  lastSyncStatus: string | null;
  lastErrorMessage: string | null;
}): SubscriptionRecord => ({
  id: row.id,
  userId: row.userId,
  channelId: row.channelId,
  status: row.status,
  lastCalendarSyncAt: row.lastCalendarSyncAt,
  lastManualSyncAt: row.lastManualSyncAt,
  lastSyncStatus:
    row.lastSyncStatus === 'SUCCESS' ||
    row.lastSyncStatus === 'FAILED' ||
    row.lastSyncStatus === 'RUNNING'
      ? row.lastSyncStatus
      : null,
  lastErrorMessage: row.lastErrorMessage,
});

export class PrismaStore implements Store {
  constructor(readonly prisma = new PrismaClient()) {}
  async findUserBySubject(subject: string) {
    const row = await this.prisma.user.findUnique({
      where: { supabaseUserId: subject },
      include: { calendar: true },
    });
    return row ? toUser(row) : null;
  }
  async findUserById(id: string) {
    const row = await this.prisma.user.findUnique({ where: { id }, include: { calendar: true } });
    return row ? toUser(row) : null;
  }
  async ensureUser(identity: AuthIdentity) {
    const row = await this.prisma.user.upsert({
      where: { supabaseUserId: identity.subject },
      update: { email: identity.email },
      create: { supabaseUserId: identity.subject, email: identity.email },
      include: { calendar: true },
    });
    return toUser(row);
  }
  async findAccountDeletion(subject: string) {
    const row = await this.prisma.accountDeletionRequest.findUnique({
      where: { supabaseUserId: subject },
    });
    return row
      ? {
          id: row.id,
          supabaseUserId: row.supabaseUserId,
          userId: row.userId,
          calendarIdSnapshot: row.calendarIdSnapshot,
          status: row.status,
          calendarDeletedAt: row.calendarDeletedAt,
          googleTokenRevokedAt: row.googleTokenRevokedAt,
          userDataDeletedAt: row.userDataDeletedAt,
          supabaseUserDeletedAt: row.supabaseUserDeletedAt,
          completedAt: row.completedAt,
        }
      : null;
  }
  async beginAccountDeletion(user: ReturnType<typeof toUser>) {
    const row = await this.prisma.accountDeletionRequest.upsert({
      where: { supabaseUserId: user.subject },
      update: { attempts: { increment: 1 }, lastErrorCode: null },
      create: {
        supabaseUserId: user.subject,
        userId: user.id,
        calendarIdSnapshot: user.calendarId,
        attempts: 1,
      },
    });
    const request = await this.findAccountDeletion(row.supabaseUserId);
    if (!request) throw new Error('account deletion request not found');
    return request;
  }
  async markAccountDeletionStep(
    id: string,
    step: 'CALENDAR_DELETED' | 'TOKEN_REVOKED' | 'DATA_DELETED' | 'AUTH_DELETED' | 'COMPLETED',
    at: Date,
  ) {
    await this.prisma.accountDeletionRequest.update({
      where: { id },
      data: {
        status: step,
        lastErrorCode: null,
        ...(step === 'CALENDAR_DELETED' ? { calendarDeletedAt: at } : {}),
        ...(step === 'TOKEN_REVOKED' ? { googleTokenRevokedAt: at } : {}),
        ...(step === 'DATA_DELETED' ? { userDataDeletedAt: at } : {}),
        ...(step === 'AUTH_DELETED' ? { supabaseUserDeletedAt: at } : {}),
        ...(step === 'COMPLETED' ? { completedAt: at } : {}),
      },
    });
  }
  async markAccountDeletionFailed(id: string, errorCode: string) {
    await this.prisma.accountDeletionRequest.update({
      where: { id },
      data: { status: 'FAILED', lastErrorCode: errorCode.slice(0, 64) },
    });
  }
  async saveCredential(userId: string, encryptedToken: string, keyId: string) {
    await this.prisma.googleCredential.upsert({
      where: { userId },
      update: {
        encryptedRefreshToken: encryptedToken,
        keyId,
        scopes: 'https://www.googleapis.com/auth/calendar',
        tokenUpdatedAt: new Date(),
      },
      create: {
        userId,
        encryptedRefreshToken: encryptedToken,
        keyId,
        scopes: 'https://www.googleapis.com/auth/calendar',
      },
    });
  }
  async completeOnboarding(
    userId: string,
    encryptedToken: string,
    keyId: string,
    calendarId: string,
  ) {
    await this.prisma.$transaction([
      this.prisma.googleCredential.upsert({
        where: { userId },
        update: {
          encryptedRefreshToken: encryptedToken,
          keyId,
          scopes: 'https://www.googleapis.com/auth/calendar',
          tokenUpdatedAt: new Date(),
        },
        create: {
          userId,
          encryptedRefreshToken: encryptedToken,
          keyId,
          scopes: 'https://www.googleapis.com/auth/calendar',
        },
      }),
      this.prisma.calendarConnection.upsert({
        where: { userId },
        update: { googleCalendarId: calendarId, status: 'ACTIVE', lastCheckedAt: new Date() },
        create: {
          userId,
          googleCalendarId: calendarId,
          status: 'ACTIVE',
          lastCheckedAt: new Date(),
        },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: { onboardingCompletedAt: new Date(), reauthRequired: false },
      }),
    ]);
    const user = await this.findUserById(userId);
    if (!user) throw new Error('user not found');
    return user;
  }
  async setCalendarId(userId: string, calendarId: string) {
    await this.prisma.calendarConnection.upsert({
      where: { userId },
      update: { googleCalendarId: calendarId, status: 'ACTIVE', lastCheckedAt: new Date() },
      create: { userId, googleCalendarId: calendarId, status: 'ACTIVE', lastCheckedAt: new Date() },
    });
  }
  async markReauthRequired(userId: string) {
    await this.prisma.user.update({ where: { id: userId }, data: { reauthRequired: true } });
  }
  async getEncryptedCredential(userId: string) {
    return (
      (
        await this.prisma.googleCredential.findUnique({
          where: { userId },
          select: { encryptedRefreshToken: true },
        })
      )?.encryptedRefreshToken ?? null
    );
  }
  async listSubscriptions(userId: string) {
    const rows = await this.prisma.userChannelSubscription.findMany({
      where: { userId },
      include: { channel: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      subscription: toSubscription(row),
      channel: toChannel(row.channel),
    }));
  }
  async countSubscriptions(userId: string) {
    return this.prisma.userChannelSubscription.count({ where: { userId } });
  }
  async findChannelByYoutubeId(youtubeChannelId: string) {
    const row = await this.prisma.youTubeChannel.findUnique({ where: { youtubeChannelId } });
    return row ? toChannel(row) : null;
  }
  async upsertChannel(channel: ChannelSummary) {
    const row = await this.prisma.youTubeChannel.upsert({
      where: { youtubeChannelId: channel.youtubeChannelId },
      update: {
        title: channel.title,
        handle: channel.handle,
        thumbnailUrl: channel.thumbnailUrl,
        channelUrl: channel.channelUrl,
      },
      create: {
        youtubeChannelId: channel.youtubeChannelId,
        title: channel.title,
        handle: channel.handle,
        thumbnailUrl: channel.thumbnailUrl,
        channelUrl: channel.channelUrl,
      },
    });
    return toChannel(row);
  }
  async createSubscriptionWithinLimit(userId: string, channelId: string, limit: number) {
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          await transaction.$queryRaw`SELECT id FROM User WHERE id = ${userId} FOR UPDATE`;
          const count = await transaction.userChannelSubscription.count({ where: { userId } });
          if (count >= limit) throw new StoreConstraintError('CHANNEL_LIMIT');
          return toSubscription(
            await transaction.userChannelSubscription.create({ data: { userId, channelId } }),
          );
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof StoreConstraintError) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new StoreConstraintError('DUPLICATE_CHANNEL');
      throw error;
    }
  }
  async getSubscription(userId: string, id: string) {
    const row = await this.prisma.userChannelSubscription.findFirst({
      where: { id, userId },
      include: { channel: true },
    });
    return row ? { subscription: toSubscription(row), channel: toChannel(row.channel) } : null;
  }
  async updateSubscription(userId: string, id: string, status: SubscriptionStatus) {
    const found = await this.prisma.userChannelSubscription.findFirst({ where: { id, userId } });
    if (!found) return null;
    return toSubscription(
      await this.prisma.userChannelSubscription.update({ where: { id }, data: { status } }),
    );
  }
  async deleteSubscription(userId: string, id: string) {
    await this.prisma.userChannelSubscription.deleteMany({ where: { id, userId } });
  }
  async listActiveSubscriptions() {
    const rows = await this.prisma.userChannelSubscription.findMany({
      where: { status: 'ACTIVE', user: { reauthRequired: false } },
      include: { channel: true, user: { include: { calendar: true } } },
    });
    return rows.map((row) => ({
      subscription: toSubscription(row),
      channel: toChannel(row.channel),
      user: toUser(row.user),
    }));
  }
  async updateChannelFetchedAt(channelId: string, at: Date) {
    await this.prisma.youTubeChannel.update({
      where: { id: channelId },
      data: { lastFetchedAt: at },
    });
  }
  async upsertBroadcasts(channelId: string, items: NormalizedBroadcast[], observedAt: Date) {
    for (const item of items)
      await this.prisma.scheduledBroadcast.upsert({
        where: { youtubeVideoId: item.youtubeVideoId },
        update: {
          title: item.title,
          kind: item.kind,
          status: item.status,
          youtubeUrl: item.youtubeUrl,
          thumbnailUrl: item.thumbnailUrl,
          scheduledStartAt: item.scheduledStartAt,
          endAt: item.endAt,
          endTimeProvisional: item.endTimeProvisional,
          actualStartAt: item.actualStartAt,
          actualEndAt: item.actualEndAt,
          missingCount: 0,
          sourceUpdatedAt: observedAt,
        },
        create: { channelId, ...item, sourceUpdatedAt: observedAt },
      });
    const rows = await this.prisma.scheduledBroadcast.findMany({
      where: { youtubeVideoId: { in: items.map((item) => item.youtubeVideoId) } },
    });
    return rows.map((row) => ({
      ...row,
      kind: row.kind,
      status: row.status === 'UNKNOWN' ? 'UNAVAILABLE' : row.status,
    }));
  }
  async listTrackableBroadcasts(channelId: string, now: Date) {
    const rows = await this.prisma.scheduledBroadcast.findMany({
      where: {
        channelId,
        scheduledStartAt: { gte: new Date(now.getTime() - 30 * 86_400_000) },
        status: { notIn: ['COMPLETED', 'CANCELLED'] },
      },
    });
    return rows.map((row) => ({
      ...row,
      status: row.status === 'UNKNOWN' ? ('UNAVAILABLE' as const) : row.status,
    }));
  }
  async markBroadcastsUnavailable(channelId: string, youtubeVideoIds: string[], observedAt: Date) {
    if (!youtubeVideoIds.length) return;
    await this.prisma.scheduledBroadcast.updateMany({
      where: { channelId, youtubeVideoId: { in: youtubeVideoIds } },
      data: { status: 'UNAVAILABLE', sourceUpdatedAt: observedAt },
    });
  }
  async listFutureBroadcasts(channelId: string, now: Date) {
    const rows = await this.prisma.scheduledBroadcast.findMany({
      where: { channelId, scheduledStartAt: { gt: now }, status: { not: 'CANCELLED' } },
      orderBy: { scheduledStartAt: 'asc' },
    });
    return rows.map((row) => ({
      ...row,
      kind: row.kind,
      status: row.status === 'UNKNOWN' ? 'UNAVAILABLE' : row.status,
    }));
  }
  async listBroadcastsForSync(channelId: string, now: Date, since: Date | null) {
    const rows = await this.prisma.scheduledBroadcast.findMany({
      where: {
        channelId,
        ...(since ? { OR: [{ endAt: { gte: now } }, { sourceUpdatedAt: { gt: since } }] } : {}),
      },
      orderBy: { scheduledStartAt: 'asc' },
    });
    return rows.map((row) => ({
      ...row,
      status: row.status === 'UNKNOWN' ? ('UNAVAILABLE' as const) : row.status,
    }));
  }
  async getMapping(userId: string, broadcastId: string) {
    const row = await this.prisma.calendarEventMapping.findUnique({
      where: { userId_broadcastId: { userId, broadcastId } },
    });
    return row
      ? {
          id: row.id,
          userId,
          broadcastId,
          eventId: row.googleCalendarEventId,
          managedFieldsHash: row.managedFieldsHash,
        }
      : null;
  }
  async saveMapping(input: Omit<MappingRecord, 'id'>) {
    const row = await this.prisma.calendarEventMapping.upsert({
      where: { userId_broadcastId: { userId: input.userId, broadcastId: input.broadcastId } },
      update: {
        googleCalendarEventId: input.eventId,
        managedFieldsHash: input.managedFieldsHash,
        lastSyncedAt: new Date(),
      },
      create: {
        userId: input.userId,
        broadcastId: input.broadcastId,
        googleCalendarEventId: input.eventId,
        managedFieldsHash: input.managedFieldsHash,
        lastSyncedAt: new Date(),
      },
    });
    return { id: row.id, ...input };
  }
  async deleteMapping(userId: string, broadcastId: string) {
    await this.prisma.calendarEventMapping.deleteMany({ where: { userId, broadcastId } });
  }
  async saveSyncResult(subscriptionId: string, result: SyncResult, at: Date, manual: boolean) {
    await this.prisma.userChannelSubscription.update({
      where: { id: subscriptionId },
      data: {
        lastSyncStatus: result.status,
        lastErrorCode: result.errorCode ?? null,
        lastErrorMessage: result.message,
        ...(result.status === 'SUCCESS' ? { lastCalendarSyncAt: at } : {}),
        ...(manual && result.status === 'RUNNING' ? { lastManualSyncAt: at } : {}),
      },
    });
  }
  async acquireSyncLease(key: string, ownerToken: string, now: Date, expiresAt: Date) {
    try {
      await this.prisma.syncLease.create({ data: { key, ownerToken, expiresAt } });
      return true;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
        throw error;
      const updated = await this.prisma.syncLease.updateMany({
        where: { key, expiresAt: { lte: now } },
        data: { ownerToken, expiresAt },
      });
      return updated.count === 1;
    }
  }
  async renewSyncLease(key: string, ownerToken: string, now: Date, expiresAt: Date) {
    const updated = await this.prisma.syncLease.updateMany({
      where: { key, ownerToken, expiresAt: { gt: now } },
      data: { expiresAt },
    });
    return updated.count === 1;
  }
  async releaseSyncLease(key: string, ownerToken: string) {
    await this.prisma.syncLease.deleteMany({ where: { key, ownerToken } });
  }
  async startSyncRun(
    type: 'MANUAL' | 'SCHEDULED',
    requestedById: string | null,
    targets: number,
    at: Date,
  ) {
    return (
      await this.prisma.syncRun.create({
        data: {
          type,
          requestedById,
          startedAt: at,
          channelsTotal: targets,
          usersTotal: targets,
        },
      })
    ).id;
  }
  async startSyncTarget(runId: string, subscriptionId: string, at: Date) {
    await this.prisma.syncTargetResult.create({
      data: {
        syncRunId: runId,
        targetType: 'SUBSCRIPTION',
        targetId: subscriptionId,
        status: 'RUNNING',
        startedAt: at,
      },
    });
  }
  async finishSyncTarget(runId: string, subscriptionId: string, result: SyncResult, at: Date) {
    await this.prisma.syncTargetResult.update({
      where: {
        syncRunId_targetType_targetId: {
          syncRunId: runId,
          targetType: 'SUBSCRIPTION',
          targetId: subscriptionId,
        },
      },
      data: {
        status: result.status,
        errorCode: result.errorCode ?? null,
        errorMessage: result.message,
        completedAt: at,
      },
    });
  }
  async finishSyncRun(
    runId: string,
    status: 'SUCCESS' | 'PARTIAL_FAILED' | 'FAILED',
    at: Date,
    errorCode?: string,
  ) {
    await this.prisma.syncRun.update({
      where: { id: runId },
      data: { status, completedAt: at, errorCode: errorCode ?? null },
    });
  }
  async maintainSyncRuns(staleBefore: Date, retainAfter: Date, at: Date) {
    await this.prisma.$transaction(async (tx) => {
      const stale = await tx.syncRun.findMany({
        where: { status: 'RUNNING', startedAt: { lt: staleBefore } },
        select: { id: true },
      });
      const staleIds = stale.map((run) => run.id);
      if (staleIds.length) {
        await tx.syncTargetResult.updateMany({
          where: { syncRunId: { in: staleIds }, status: 'RUNNING' },
          data: {
            status: 'FAILED',
            completedAt: at,
            errorCode: 'SYNC_RUN_STALE',
            errorMessage: '同期プロセスが完了を記録しませんでした',
          },
        });
        await tx.syncRun.updateMany({
          where: { id: { in: staleIds }, status: 'RUNNING' },
          data: { status: 'FAILED', completedAt: at, errorCode: 'SYNC_RUN_STALE' },
        });
      }
      await tx.syncRun.deleteMany({
        where: { completedAt: { lt: retainAfter } },
      });
    });
  }
  async deleteUserData(requestId: string, userId: string) {
    const at = new Date();
    await this.prisma.$transaction([
      this.prisma.user.deleteMany({ where: { id: userId } }),
      this.prisma.accountDeletionRequest.update({
        where: { id: requestId },
        data: { userId: null, status: 'DATA_DELETED', userDataDeletedAt: at },
      }),
    ]);
  }
}
