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
  SyncRunRecord,
  UserRecord,
  DeletionStep,
  LeaseOwnership,
  YouTubeQuotaBucket,
  YouTubeQuotaMode,
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
  private leases = new Map<string, { ownerToken: string; expiresAt: Date; version: number }>();
  private quota = new Map<string, { unitsUsed: number; unitsReserved: number }>();
  readonly syncRuns: Array<{
    id: string;
    status: string;
    type: string;
    requestedById: string | null;
    queuedAt: Date;
    startedAt: Date | null;
    heartbeatAt: Date | null;
    completedAt: Date | null;
    errorCode: string | null;
  }> = [];
  readonly syncTargets: Array<{
    runId: string;
    subscriptionId: string;
    status: string;
    queuedAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    errorCode: string | null;
    errorMessage: string | null;
    youtubeFetchStatus: string;
    databaseUpdateStatus: string;
    calendarSyncStatus: string;
    snapshotVersion: number | null;
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
    this.quota.clear();
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
      lastErrorCode: null,
      calendarDeletedAt: null,
      googleTokenRevokedAt: null,
      userDataDeletedAt: null,
      supabaseUserDeletedAt: null,
      completedAt: null,
    };
    this.deletions.push(request);
    return request;
  }
  private ownsLease(lease: LeaseOwnership, at: Date) {
    const found = this.leases.get(lease.key);
    return Boolean(
      found &&
      found.ownerToken === lease.ownerToken &&
      found.version === lease.version &&
      found.expiresAt > at,
    );
  }
  async markAccountDeletionStep(id: string, step: DeletionStep, at: Date, lease: LeaseOwnership) {
    if (!this.ownsLease(lease, at)) return false;
    const request = this.deletions.find((item) => item.id === id);
    if (!request) throw new Error('deletion request not found');
    request.status = step;
    request.lastErrorCode = null;
    if (step === 'CALENDAR_DELETED') request.calendarDeletedAt = at;
    if (step === 'TOKEN_REVOKED') request.googleTokenRevokedAt = at;
    if (step === 'DATA_DELETED') request.userDataDeletedAt = at;
    if (step === 'AUTH_DELETED') request.supabaseUserDeletedAt = at;
    if (step === 'COMPLETED') request.completedAt = at;
    return true;
  }
  async markAccountDeletionFailed(id: string, errorCode: string, at: Date, lease: LeaseOwnership) {
    if (!this.ownsLease(lease, at)) return false;
    const request = this.deletions.find((item) => item.id === id);
    if (request) {
      request.status = 'FAILED';
      request.lastErrorCode = errorCode;
    }
    return Boolean(request);
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
  async findChannelById(id: string) {
    return this.channels.find((item) => item.id === id) ?? null;
  }
  async upsertChannel(input: ChannelSummary) {
    const found = await this.findChannelByYoutubeId(input.youtubeChannelId);
    if (found) {
      Object.assign(found, input);
      return found;
    }
    const channel: ChannelRecord = {
      ...input,
      lastFetchedAt: null,
      fetchStartedAt: null,
      fetchCompletedAt: null,
      lastFetchSucceededAt: null,
      snapshotVersion: 0,
      lastFetchStatus: 'NEVER',
      nextFetchAt: null,
    };
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
    if (channel)
      Object.assign(channel, {
        lastFetchedAt: at,
        fetchCompletedAt: at,
        lastFetchSucceededAt: at,
        lastFetchStatus: 'SUCCESS' as const,
        nextFetchAt: null,
        snapshotVersion: channel.snapshotVersion + 1,
      });
  }
  async startChannelFetch(channelId: string, at: Date, lease: LeaseOwnership) {
    if (!this.ownsLease(lease, at)) return false;
    const channel = this.channels.find((item) => item.id === channelId);
    if (!channel) return false;
    Object.assign(channel, {
      fetchStartedAt: at,
      lastFetchStatus: 'RUNNING' as const,
      nextFetchAt: null,
    });
    return true;
  }
  async commitChannelSnapshot(
    channelId: string,
    items: NormalizedBroadcast[],
    unavailableVideoIds: string[],
    completedAt: Date,
    lease: LeaseOwnership,
  ) {
    if (!this.ownsLease(lease, completedAt)) return null;
    await this.upsertBroadcasts(channelId, items, completedAt);
    await this.markBroadcastsUnavailable(channelId, unavailableVideoIds, completedAt);
    const channel = this.channels.find((item) => item.id === channelId);
    if (!channel) return null;
    const version = channel.snapshotVersion + 1;
    Object.assign(channel, {
      lastFetchedAt: completedAt,
      fetchCompletedAt: completedAt,
      lastFetchSucceededAt: completedAt,
      snapshotVersion: version,
      lastFetchStatus: 'SUCCESS' as const,
      nextFetchAt: null,
    });
    return version;
  }
  async finishChannelFetch(
    channelId: string,
    status: 'DEFERRED' | 'FAILED',
    at: Date,
    nextFetchAt: Date | null,
    lease: LeaseOwnership,
  ) {
    if (!this.ownsLease(lease, at)) return false;
    const channel = this.channels.find((item) => item.id === channelId);
    if (!channel) return false;
    Object.assign(channel, { fetchCompletedAt: at, lastFetchStatus: status, nextFetchAt });
    return true;
  }
  async upsertBroadcasts(channelId: string, inputs: NormalizedBroadcast[], observedAt: Date) {
    return inputs.map((input) => {
      const found = this.broadcasts.find((item) => item.youtubeVideoId === input.youtubeVideoId);
      if (found) {
        const changed =
          found.title !== input.title ||
          found.kind !== input.kind ||
          found.status !== input.status ||
          found.youtubeUrl !== input.youtubeUrl ||
          found.thumbnailUrl !== input.thumbnailUrl ||
          found.scheduledStartAt.getTime() !== input.scheduledStartAt.getTime() ||
          found.endAt.getTime() !== input.endAt.getTime() ||
          found.endTimeProvisional !== input.endTimeProvisional ||
          found.actualStartAt?.getTime() !== input.actualStartAt?.getTime() ||
          found.actualEndAt?.getTime() !== input.actualEndAt?.getTime();
        Object.assign(found, input, {
          missingCount: 0,
          ...(changed ? { sourceUpdatedAt: observedAt } : {}),
        });
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
  async listTrackableBroadcasts(channelId: string, now: Date, limit: number, windowDays: number) {
    return this.broadcasts
      .filter(
        (item) =>
          item.channelId === channelId &&
          item.scheduledStartAt >= new Date(now.getTime() - windowDays * 86_400_000) &&
          !['COMPLETED', 'CANCELLED'].includes(item.status),
      )
      .sort((left, right) => right.scheduledStartAt.getTime() - left.scheduledStartAt.getTime())
      .slice(0, limit);
  }
  async markBroadcastsUnavailable(channelId: string, ids: string[], observedAt: Date) {
    this.broadcasts
      .filter(
        (item) =>
          item.channelId === channelId &&
          ids.includes(item.youtubeVideoId) &&
          item.status !== 'UNAVAILABLE',
      )
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
    if (['SUCCESS', 'SKIPPED', 'DEFERRED'].includes(result.status)) item.lastCalendarSyncAt = at;
    if (manual && result.status === 'RUNNING') item.lastManualSyncAt = at;
  }
  async acquireSyncLease(key: string, ownerToken: string, now: Date, ttlMs: number) {
    const found = this.leases.get(key);
    if (found && found.expiresAt > now) return null;
    const version = (found?.version ?? 0) + 1;
    this.leases.set(key, { ownerToken, expiresAt: new Date(now.getTime() + ttlMs), version });
    return { key, ownerToken, version };
  }
  async renewSyncLease(lease: LeaseOwnership, now: Date, ttlMs: number) {
    const found = this.leases.get(lease.key);
    if (!this.ownsLease(lease, now) || !found) return false;
    found.expiresAt = new Date(now.getTime() + ttlMs);
    return true;
  }
  async releaseSyncLease(lease: LeaseOwnership) {
    if (!this.ownsLease(lease, new Date(0))) return false;
    this.leases.delete(lease.key);
    return true;
  }
  async reserveYouTubeQuota(
    quotaDate: string,
    bucket: YouTubeQuotaBucket,
    units: number,
    dailyBudget: number,
    scheduledReserve: number,
    mode: YouTubeQuotaMode,
  ) {
    const key = `${quotaDate}:${bucket}`;
    const usage = this.quota.get(key) ?? { unitsUsed: 0, unitsReserved: 0 };
    this.quota.set(key, usage);
    const effectiveBudget = mode === 'MANUAL' ? dailyBudget - scheduledReserve : dailyBudget;
    const granted = usage.unitsUsed + usage.unitsReserved + units <= effectiveBudget;
    if (granted) usage.unitsReserved += units;
    return {
      granted,
      unitsUsed: usage.unitsUsed,
      unitsReserved: usage.unitsReserved,
      remaining: Math.max(0, dailyBudget - usage.unitsUsed - usage.unitsReserved),
    };
  }
  async consumeYouTubeQuota(quotaDate: string, bucket: YouTubeQuotaBucket, units: number) {
    const usage = this.quota.get(`${quotaDate}:${bucket}`);
    if (!usage || usage.unitsReserved < units) throw new Error('quota reservation not found');
    usage.unitsReserved -= units;
    usage.unitsUsed += units;
  }
  async startSyncRun(
    type: 'MANUAL' | 'SCHEDULED',
    requestedById: string | null,
    _targets: number,
    at: Date,
  ) {
    const id = this.cuid();
    this.syncRuns.push({
      id,
      type,
      status: 'RUNNING',
      requestedById,
      queuedAt: at,
      startedAt: at,
      heartbeatAt: at,
      completedAt: null,
      errorCode: null,
    });
    return id;
  }
  private manualRun(runId: string): SyncRunRecord | null {
    const run = this.syncRuns.find((item) => item.id === runId);
    const target = this.syncTargets.find((item) => item.runId === runId);
    if (!run || (run.type !== 'INITIAL' && run.type !== 'MANUAL') || !run.requestedById || !target)
      return null;
    return {
      id: run.id,
      subscriptionId: target.subscriptionId,
      requestedById: run.requestedById,
      type: run.type,
      status: run.status as SyncRunRecord['status'],
      queuedAt: run.queuedAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      heartbeatAt: run.heartbeatAt,
      errorCode: run.errorCode,
      errorMessage: target.errorMessage,
      youtubeFetchStatus: target.youtubeFetchStatus as SyncRunRecord['youtubeFetchStatus'],
      databaseUpdateStatus: target.databaseUpdateStatus as SyncRunRecord['databaseUpdateStatus'],
      calendarSyncStatus: target.calendarSyncStatus as SyncRunRecord['calendarSyncStatus'],
      snapshotVersion: target.snapshotVersion,
    };
  }
  async enqueueSyncRun(
    userId: string,
    subscriptionId: string,
    at: Date,
    cooldownBefore: Date,
    trigger: 'INITIAL' | 'MANUAL',
  ) {
    const subscription = this.subscriptions.find(
      (item) => item.id === subscriptionId && item.userId === userId,
    );
    if (!subscription) throw new StoreConstraintError('SUBSCRIPTION_NOT_FOUND');
    const active = this.syncTargets.find((target) => {
      const run = this.syncRuns.find((item) => item.id === target.runId);
      return (
        target.subscriptionId === subscriptionId &&
        (target.status === 'QUEUED' || target.status === 'RUNNING') &&
        (run?.type === 'INITIAL' || run?.type === 'MANUAL') &&
        run.requestedById === userId
      );
    });
    if (active) {
      const run = this.manualRun(active.runId);
      if (!run) throw new Error('active sync run is incomplete');
      return { run, created: false };
    }
    if (
      trigger === 'MANUAL' &&
      subscription.lastManualSyncAt &&
      subscription.lastManualSyncAt > cooldownBefore
    )
      throw new StoreConstraintError('SYNC_COOLDOWN');
    const id = this.cuid();
    this.syncRuns.push({
      id,
      type: trigger,
      status: 'QUEUED',
      requestedById: userId,
      queuedAt: at,
      startedAt: null,
      heartbeatAt: null,
      completedAt: null,
      errorCode: null,
    });
    this.syncTargets.push({
      runId: id,
      subscriptionId,
      status: 'QUEUED',
      queuedAt: at,
      startedAt: null,
      completedAt: null,
      errorCode: null,
      errorMessage: null,
      youtubeFetchStatus: 'NOT_STARTED',
      databaseUpdateStatus: 'NOT_STARTED',
      calendarSyncStatus: 'NOT_STARTED',
      snapshotVersion: null,
    });
    subscription.lastSyncStatus = 'QUEUED';
    subscription.lastErrorMessage = null;
    const run = this.manualRun(id);
    if (!run) throw new Error('queued sync run is incomplete');
    return { run, created: true };
  }
  async getSyncRunForUser(runId: string, userId: string) {
    const run = this.manualRun(runId);
    return run?.requestedById === userId ? run : null;
  }
  async claimSyncRun(runId: string, at: Date, staleBefore: Date) {
    const run = this.syncRuns.find(
      (item) => item.id === runId && (item.type === 'INITIAL' || item.type === 'MANUAL'),
    );
    if (!run) return null;
    const heartbeat = run.heartbeatAt ?? run.startedAt ?? run.queuedAt;
    if (run.status !== 'QUEUED' && !(run.status === 'RUNNING' && heartbeat < staleBefore))
      return null;
    run.status = 'RUNNING';
    run.startedAt ??= at;
    run.heartbeatAt = at;
    run.completedAt = null;
    run.errorCode = null;
    const target = this.syncTargets.find((item) => item.runId === runId);
    if (target) {
      target.status = 'RUNNING';
      target.startedAt = at;
      target.completedAt = null;
      target.errorCode = null;
      target.errorMessage = null;
    }
    return this.manualRun(runId);
  }
  async heartbeatSyncRun(runId: string, at: Date) {
    const run = this.syncRuns.find((item) => item.id === runId && item.status === 'RUNNING');
    if (run) run.heartbeatAt = at;
  }
  async listRecoverableSyncRunIds(staleBefore: Date, limit: number) {
    return this.syncRuns
      .filter((run) => {
        const heartbeat = run.heartbeatAt ?? run.startedAt ?? run.queuedAt;
        return (
          (run.type === 'INITIAL' || run.type === 'MANUAL') &&
          (run.status === 'QUEUED' || (run.status === 'RUNNING' && heartbeat < staleBefore))
        );
      })
      .sort((left, right) => left.queuedAt.getTime() - right.queuedAt.getTime())
      .slice(0, limit)
      .map(({ id }) => id);
  }
  async startSyncTarget(runId: string, subscriptionId: string, at: Date) {
    const existing = this.syncTargets.find(
      (item) => item.runId === runId && item.subscriptionId === subscriptionId,
    );
    if (existing) {
      existing.status = 'RUNNING';
      existing.startedAt = at;
      return;
    }
    this.syncTargets.push({
      runId,
      subscriptionId,
      status: 'RUNNING',
      queuedAt: at,
      startedAt: at,
      completedAt: null,
      errorCode: null,
      errorMessage: null,
      youtubeFetchStatus: 'NOT_STARTED',
      databaseUpdateStatus: 'NOT_STARTED',
      calendarSyncStatus: 'NOT_STARTED',
      snapshotVersion: null,
    });
  }
  async finishSyncTarget(runId: string, subscriptionId: string, result: SyncResult, at: Date) {
    const target = this.syncTargets.find(
      (item) => item.runId === runId && item.subscriptionId === subscriptionId,
    );
    if (target) {
      target.status = result.status;
      target.completedAt = at;
      target.errorCode = result.errorCode ?? null;
      target.errorMessage = result.message;
      target.youtubeFetchStatus = result.phases?.youtubeFetch ?? target.youtubeFetchStatus;
      target.databaseUpdateStatus = result.phases?.databaseUpdate ?? target.databaseUpdateStatus;
      target.calendarSyncStatus = result.phases?.calendarSync ?? target.calendarSyncStatus;
      target.snapshotVersion = result.snapshotVersion ?? target.snapshotVersion;
    }
  }
  async finishSyncRun(
    runId: string,
    status: 'SUCCESS' | 'PARTIAL_SUCCESS' | 'PARTIAL_FAILED' | 'DEFERRED' | 'FAILED',
    at: Date,
    errorCode?: string,
  ) {
    const run = this.syncRuns.find((item) => item.id === runId);
    if (run) {
      run.status = status;
      run.completedAt = at;
      run.heartbeatAt = at;
      run.errorCode = errorCode ?? null;
    }
  }
  async maintainSyncRuns(staleBefore: Date, retainAfter: Date, at: Date) {
    const staleIds = new Set(
      this.syncRuns
        .filter(
          (run) =>
            run.status === 'RUNNING' &&
            (run.heartbeatAt ?? run.startedAt ?? run.queuedAt) < staleBefore,
        )
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
  async deleteUserData(requestId: string, userId: string, at: Date, lease: LeaseOwnership) {
    if (!this.ownsLease(lease, at)) return false;
    this.users = this.users.filter((item) => item.id !== userId);
    this.credentials.delete(userId);
    this.subscriptions = this.subscriptions.filter((item) => item.userId !== userId);
    this.mappings = this.mappings.filter((item) => item.userId !== userId);
    const request = this.deletions.find((item) => item.id === requestId);
    if (request) {
      request.userId = null;
      request.status = 'DATA_DELETED';
      request.userDataDeletedAt = at;
    }
    return Boolean(request);
  }
}
