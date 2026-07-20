import { PrismaClient } from '@prisma/client';
import type { ChannelSummary, SubscriptionStatus } from '@oshi-schedule/shared';
import type {
  AuthIdentity,
  MappingRecord,
  Store,
  SubscriptionRecord,
  SyncResult,
} from '../../application/models.js';
import type { NormalizedBroadcast } from '../../domain/scheduling.js';

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
  async createSubscription(userId: string, channelId: string) {
    return toSubscription(
      await this.prisma.userChannelSubscription.create({ data: { userId, channelId } }),
    );
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
      where: { status: 'ACTIVE' },
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
  async upsertBroadcasts(channelId: string, items: NormalizedBroadcast[]) {
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
        },
        create: { channelId, ...item },
      });
    const rows = await this.prisma.scheduledBroadcast.findMany({
      where: { youtubeVideoId: { in: items.map((item) => item.youtubeVideoId) } },
    });
    return rows.map((row) => ({
      ...row,
      kind: row.kind,
      status: row.status === 'UNKNOWN' ? 'UPCOMING' : row.status,
    }));
  }
  async listFutureBroadcasts(channelId: string, now: Date) {
    const rows = await this.prisma.scheduledBroadcast.findMany({
      where: { channelId, endAt: { gte: now }, status: { not: 'CANCELLED' } },
      orderBy: { scheduledStartAt: 'asc' },
    });
    return rows.map((row) => ({
      ...row,
      kind: row.kind,
      status: row.status === 'UNKNOWN' ? 'UPCOMING' : row.status,
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
        lastErrorMessage: result.message,
        lastCalendarSyncAt: at,
        ...(manual ? { lastManualSyncAt: at } : {}),
      },
    });
  }
  async deleteAccount(userId: string) {
    await this.prisma.user.delete({ where: { id: userId } });
  }
}
