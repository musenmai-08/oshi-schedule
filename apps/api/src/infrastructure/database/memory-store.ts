import { randomUUID } from 'node:crypto';
import type { ChannelSummary, SubscriptionStatus } from '@oshi-schedule/shared';
import type {
  AuthIdentity,
  BroadcastRecord,
  ChannelRecord,
  MappingRecord,
  Store,
  SubscriptionRecord,
  SyncResult,
  UserRecord,
} from '../../application/models.js';
import type { NormalizedBroadcast } from '../../domain/scheduling.js';

export class MemoryStore implements Store {
  private users: UserRecord[] = [];
  private credentials = new Map<string, string>();
  private channels: ChannelRecord[] = [];
  private subscriptions: SubscriptionRecord[] = [];
  private broadcasts: BroadcastRecord[] = [];
  private mappings: MappingRecord[] = [];

  reset() {
    this.users = [];
    this.credentials.clear();
    this.channels = [];
    this.subscriptions = [];
    this.broadcasts = [];
    this.mappings = [];
  }
  async findUserBySubject(subject: string) {
    return this.users.find((item) => item.subject === subject) ?? null;
  }
  async findUserById(id: string) {
    return this.users.find((item) => item.id === id) ?? null;
  }
  async ensureUser(identity: AuthIdentity) {
    const found = await this.findUserBySubject(identity.subject);
    if (found) return found;
    const user: UserRecord = {
      id: randomUUID(),
      subject: identity.subject,
      email: identity.email,
      onboardingCompleted: false,
      reauthRequired: false,
      calendarId: null,
    };
    this.users.push(user);
    return user;
  }
  async saveCredential(userId: string, encryptedToken: string) {
    this.credentials.set(userId, encryptedToken);
  }
  async completeOnboarding(
    userId: string,
    encryptedToken: string,
    _keyId: string,
    calendarId: string,
  ) {
    const user = await this.findUserById(userId);
    if (!user) throw new Error('user not found');
    this.credentials.set(userId, encryptedToken);
    Object.assign(user, { onboardingCompleted: true, reauthRequired: false, calendarId });
    return user;
  }
  async setCalendarId(userId: string, calendarId: string) {
    const user = await this.findUserById(userId);
    if (user) user.calendarId = calendarId;
  }
  async markReauthRequired(userId: string) {
    const user = await this.findUserById(userId);
    if (user) user.reauthRequired = true;
  }
  async getEncryptedCredential(userId: string) {
    return this.credentials.get(userId) ?? null;
  }
  async listSubscriptions(userId: string) {
    return this.subscriptions
      .filter((item) => item.userId === userId)
      .map((subscription) => {
        const channel = this.channels.find((item) => item.id === subscription.channelId);
        if (!channel) throw new Error('channel invariant failed');
        return { subscription, channel };
      });
  }
  async countSubscriptions(userId: string) {
    return this.subscriptions.filter((item) => item.userId === userId).length;
  }
  async findChannelByYoutubeId(id: string) {
    return this.channels.find((item) => item.youtubeChannelId === id) ?? null;
  }
  async upsertChannel(input: ChannelSummary) {
    const found = await this.findChannelByYoutubeId(input.youtubeChannelId);
    if (found) {
      Object.assign(found, input);
      return found;
    }
    const channel: ChannelRecord = { ...input, lastFetchedAt: null };
    this.channels.push(channel);
    return channel;
  }
  async createSubscription(userId: string, channelId: string) {
    if (this.subscriptions.some((item) => item.userId === userId && item.channelId === channelId))
      throw new Error('duplicate');
    const item: SubscriptionRecord = {
      id: randomUUID(),
      userId,
      channelId,
      status: 'ACTIVE',
      lastCalendarSyncAt: null,
      lastManualSyncAt: null,
      lastSyncStatus: null,
      lastErrorMessage: null,
    };
    this.subscriptions.push(item);
    return item;
  }
  async getSubscription(userId: string, id: string) {
    const subscription = this.subscriptions.find(
      (item) => item.id === id && item.userId === userId,
    );
    if (!subscription) return null;
    const channel = this.channels.find((item) => item.id === subscription.channelId);
    return channel ? { subscription, channel } : null;
  }
  async updateSubscription(userId: string, id: string, status: SubscriptionStatus) {
    const item = this.subscriptions.find((row) => row.id === id && row.userId === userId);
    if (!item) return null;
    item.status = status;
    return item;
  }
  async deleteSubscription(userId: string, id: string) {
    this.subscriptions = this.subscriptions.filter(
      (row) => !(row.id === id && row.userId === userId),
    );
  }
  async listActiveSubscriptions() {
    return this.subscriptions
      .filter((item) => item.status === 'ACTIVE')
      .flatMap((subscription) => {
        const channel = this.channels.find((item) => item.id === subscription.channelId);
        const user = this.users.find((item) => item.id === subscription.userId);
        return channel && user ? [{ subscription, channel, user }] : [];
      });
  }
  async updateChannelFetchedAt(channelId: string, at: Date) {
    const channel = this.channels.find((item) => item.id === channelId);
    if (channel) channel.lastFetchedAt = at;
  }
  async upsertBroadcasts(channelId: string, inputs: NormalizedBroadcast[]) {
    return inputs.map((input) => {
      const found = this.broadcasts.find((item) => item.youtubeVideoId === input.youtubeVideoId);
      if (found) {
        Object.assign(found, input, { missingCount: 0 });
        return found;
      }
      const item: BroadcastRecord = { ...input, id: randomUUID(), channelId, missingCount: 0 };
      this.broadcasts.push(item);
      return item;
    });
  }
  async listFutureBroadcasts(channelId: string, now: Date) {
    return this.broadcasts.filter(
      (item) => item.channelId === channelId && item.endAt >= now && item.status !== 'CANCELLED',
    );
  }
  async getMapping(userId: string, broadcastId: string) {
    return (
      this.mappings.find((item) => item.userId === userId && item.broadcastId === broadcastId) ??
      null
    );
  }
  async saveMapping(input: Omit<MappingRecord, 'id'>) {
    const found = await this.getMapping(input.userId, input.broadcastId);
    if (found) {
      Object.assign(found, input);
      return found;
    }
    const item = { ...input, id: randomUUID() };
    this.mappings.push(item);
    return item;
  }
  async deleteMapping(userId: string, broadcastId: string) {
    this.mappings = this.mappings.filter(
      (item) => !(item.userId === userId && item.broadcastId === broadcastId),
    );
  }
  async saveSyncResult(subscriptionId: string, result: SyncResult, at: Date, manual: boolean) {
    const item = this.subscriptions.find((row) => row.id === subscriptionId);
    if (!item) return;
    item.lastSyncStatus = result.status;
    item.lastErrorMessage = result.message;
    item.lastCalendarSyncAt = at;
    if (manual) item.lastManualSyncAt = at;
  }
  async deleteAccount(userId: string) {
    this.users = this.users.filter((item) => item.id !== userId);
    this.credentials.delete(userId);
    this.subscriptions = this.subscriptions.filter((item) => item.userId !== userId);
    this.mappings = this.mappings.filter((item) => item.userId !== userId);
  }
}
