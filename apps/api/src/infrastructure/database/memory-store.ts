import { randomBytes, randomUUID } from 'node:crypto';
import type { ChannelSummary, SubscriptionStatus } from '@oshi-schedule/shared';
import type {
  AuthIdentity,
  AccountDeletionRecord,
  BroadcastRecord,
  ChannelRecord,
  MappingRecord,
  Store,
  SubscriptionRecord,
  SyncResult,
  UserRecord,
  DeletionStep,
} from '../../application/models.js';
import type { NormalizedBroadcast } from '../../domain/scheduling.js';
import { StoreConstraintError } from '../../domain/errors.js';

export class MemoryStore implements Store {
  private users: UserRecord[] = [];
  private credentials = new Map<string, string>();
  private channels: ChannelRecord[] = [];
  private subscriptions: SubscriptionRecord[] = [];
  private broadcasts: BroadcastRecord[] = [];
  private mappings: MappingRecord[] = [];
  private deletions: AccountDeletionRecord[] = [];
  private leases = new Map<string, { ownerToken: string; expiresAt: Date }>();
  readonly syncRuns: Array<{
    id: string;
    status: string;
    type: string;
    startedAt: Date;
    completedAt: Date | null;
  }> = [];
  readonly syncTargets: Array<{
    runId: string;
    subscriptionId: string;
    status: string;
    startedAt: Date;
    completedAt: Date | null;
  }> = [];

  constructor(private readonly seedDemoUser = false) {
    this.seedDemo();
  }

  private cuid() {
    return `c${randomBytes(12).toString('hex')}`;
  }
  private seedDemo() {
    if (!this.seedDemoUser) return;
    this.users.push({
      id: this.cuid(),
      subject: 'demo-user',
      email: 'developer@example.com',
      onboardingCompleted: true,
      reauthRequired: false,
      calendarId: 'fake-calendar-demo',
    });
  }

  reset() {
    this.users = [];
    this.credentials.clear();
    this.channels = [];
    this.subscriptions = [];
    this.broadcasts = [];
    this.mappings = [];
    this.deletions = [];
    this.leases.clear();
    this.syncRuns.length = 0;
    this.syncTargets.length = 0;
    this.seedDemo();
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
      id: this.cuid(),
      subject: identity.subject,
      email: identity.email,
      onboardingCompleted: false,
      reauthRequired: false,
      calendarId: null,
    };
    this.users.push(user);
    return user;
  }
  async findAccountDeletion(subject: string) {
    return this.deletions.find((item) => item.supabaseUserId === subject) ?? null;
  }
  async beginAccountDeletion(user: UserRecord) {
    const found = await this.findAccountDeletion(user.subject);
    if (found) return found;
    const request: AccountDeletionRecord = {
      id: this.cuid(),
      supabaseUserId: user.subject,
      userId: user.id,
      calendarIdSnapshot: user.calendarId,
      status: 'REQUESTED',
      calendarDeletedAt: null,
      googleTokenRevokedAt: null,
      userDataDeletedAt: null,
      supabaseUserDeletedAt: null,
      completedAt: null,
    };
    this.deletions.push(request);
    return request;
  }
  async markAccountDeletionStep(id: string, step: DeletionStep, at: Date) {
    const request = this.deletions.find((item) => item.id === id);
    if (!request) throw new Error('deletion request not found');
    request.status = step;
    if (step === 'CALENDAR_DELETED') request.calendarDeletedAt = at;
    if (step === 'TOKEN_REVOKED') request.googleTokenRevokedAt = at;
    if (step === 'DATA_DELETED') request.userDataDeletedAt = at;
    if (step === 'AUTH_DELETED') request.supabaseUserDeletedAt = at;
    if (step === 'COMPLETED') request.completedAt = at;
  }
  async markAccountDeletionFailed(id: string) {
    const request = this.deletions.find((item) => item.id === id);
    if (request) request.status = 'FAILED';
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
  async createSubscriptionWithinLimit(userId: string, channelId: string, limit: number) {
    if (this.subscriptions.some((item) => item.userId === userId && item.channelId === channelId))
      throw new StoreConstraintError('DUPLICATE_CHANNEL');
    if (this.subscriptions.filter((item) => item.userId === userId).length >= limit)
      throw new StoreConstraintError('CHANNEL_LIMIT');
    const item: SubscriptionRecord = {
      id: this.cuid(),
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
        return channel && user && !user.reauthRequired ? [{ subscription, channel, user }] : [];
      });
  }
  async updateChannelFetchedAt(channelId: string, at: Date) {
    const channel = this.channels.find((item) => item.id === channelId);
    if (channel) channel.lastFetchedAt = at;
  }
  async upsertBroadcasts(channelId: string, inputs: NormalizedBroadcast[], observedAt: Date) {
    return inputs.map((input) => {
      const found = this.broadcasts.find((item) => item.youtubeVideoId === input.youtubeVideoId);
      if (found) {
        Object.assign(found, input, { missingCount: 0, sourceUpdatedAt: observedAt });
        return found;
      }
      const item: BroadcastRecord = {
        ...input,
        id: this.cuid(),
        channelId,
        missingCount: 0,
        sourceUpdatedAt: observedAt,
      };
      this.broadcasts.push(item);
      return item;
    });
  }
  async listTrackableBroadcasts(channelId: string, now: Date) {
    return this.broadcasts.filter(
      (item) =>
        item.channelId === channelId &&
        item.scheduledStartAt >= new Date(now.getTime() - 30 * 86_400_000) &&
        !['COMPLETED', 'CANCELLED'].includes(item.status),
    );
  }
  async markBroadcastsUnavailable(channelId: string, ids: string[], observedAt: Date) {
    this.broadcasts
      .filter((item) => item.channelId === channelId && ids.includes(item.youtubeVideoId))
      .forEach((item) =>
        Object.assign(item, { status: 'UNAVAILABLE', sourceUpdatedAt: observedAt }),
      );
  }
  async listFutureBroadcasts(channelId: string, now: Date) {
    return this.broadcasts.filter(
      (item) =>
        item.channelId === channelId && item.scheduledStartAt > now && item.status !== 'CANCELLED',
    );
  }
  async listBroadcastsForSync(channelId: string, now: Date, since: Date | null) {
    return this.broadcasts.filter(
      (item) =>
        item.channelId === channelId &&
        (item.endAt >= now ||
          !since ||
          Boolean(item.sourceUpdatedAt && item.sourceUpdatedAt > since)),
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
    if (result.status === 'SUCCESS') item.lastCalendarSyncAt = at;
    if (manual && result.status === 'RUNNING') item.lastManualSyncAt = at;
  }
  async acquireSyncLease(key: string, ownerToken: string, now: Date, expiresAt: Date) {
    const found = this.leases.get(key);
    if (found && found.expiresAt > now) return false;
    this.leases.set(key, { ownerToken, expiresAt });
    return true;
  }
  async renewSyncLease(key: string, ownerToken: string, now: Date, expiresAt: Date) {
    const found = this.leases.get(key);
    if (!found || found.ownerToken !== ownerToken || found.expiresAt <= now) return false;
    found.expiresAt = expiresAt;
    return true;
  }
  async releaseSyncLease(key: string, ownerToken: string) {
    if (this.leases.get(key)?.ownerToken === ownerToken) this.leases.delete(key);
  }
  async startSyncRun(
    type: 'MANUAL' | 'SCHEDULED',
    _requestedById: string | null,
    _targets: number,
    at: Date,
  ) {
    const id = this.cuid();
    this.syncRuns.push({ id, type, status: 'RUNNING', startedAt: at, completedAt: null });
    return id;
  }
  async startSyncTarget(runId: string, subscriptionId: string, at: Date) {
    this.syncTargets.push({
      runId,
      subscriptionId,
      status: 'RUNNING',
      startedAt: at,
      completedAt: null,
    });
  }
  async finishSyncTarget(runId: string, subscriptionId: string, result: SyncResult, at: Date) {
    const target = this.syncTargets.find(
      (item) => item.runId === runId && item.subscriptionId === subscriptionId,
    );
    if (target) {
      target.status = result.status;
      target.completedAt = at;
    }
  }
  async finishSyncRun(runId: string, status: 'SUCCESS' | 'PARTIAL_FAILED' | 'FAILED', at: Date) {
    const run = this.syncRuns.find((item) => item.id === runId);
    if (run) {
      run.status = status;
      run.completedAt = at;
    }
  }
  async maintainSyncRuns(staleBefore: Date, retainAfter: Date, at: Date) {
    const staleIds = new Set(
      this.syncRuns
        .filter((run) => run.status === 'RUNNING' && run.startedAt < staleBefore)
        .map((run) => run.id),
    );
    for (const run of this.syncRuns) {
      if (!staleIds.has(run.id)) continue;
      run.status = 'FAILED';
      run.completedAt = at;
    }
    for (const target of this.syncTargets) {
      if (staleIds.has(target.runId) && target.status === 'RUNNING') {
        target.status = 'FAILED';
        target.completedAt = at;
      }
    }
    const expiredIds = new Set(
      this.syncRuns
        .filter((run) => run.completedAt && run.completedAt < retainAfter)
        .map((run) => run.id),
    );
    for (let index = this.syncRuns.length - 1; index >= 0; index -= 1) {
      if (expiredIds.has(this.syncRuns[index]!.id)) this.syncRuns.splice(index, 1);
    }
    for (let index = this.syncTargets.length - 1; index >= 0; index -= 1) {
      if (expiredIds.has(this.syncTargets[index]!.runId)) this.syncTargets.splice(index, 1);
    }
  }
  async deleteUserData(requestId: string, userId: string) {
    this.users = this.users.filter((item) => item.id !== userId);
    this.credentials.delete(userId);
    this.subscriptions = this.subscriptions.filter((item) => item.userId !== userId);
    this.mappings = this.mappings.filter((item) => item.userId !== userId);
    const request = this.deletions.find((item) => item.id === requestId);
    if (request) request.userId = null;
  }
}
