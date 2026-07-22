import type { BroadcastStatus, ChannelSummary, SubscriptionStatus } from '@oshi-schedule/shared';
import type { CalendarEventInput, NormalizedBroadcast } from '../domain/scheduling.js';

export interface AuthIdentity {
  subject: string;
  email: string;
}
export interface UserRecord {
  id: string;
  subject: string;
  email: string;
  onboardingCompleted: boolean;
  reauthRequired: boolean;
  calendarId: string | null;
}
export interface ChannelRecord extends ChannelSummary {
  lastFetchedAt: Date | null;
}
export interface SubscriptionRecord {
  id: string;
  userId: string;
  channelId: string;
  status: SubscriptionStatus;
  lastCalendarSyncAt: Date | null;
  lastManualSyncAt: Date | null;
  lastSyncStatus: 'SUCCESS' | 'FAILED' | 'RUNNING' | 'SKIPPED' | null;
  lastErrorMessage: string | null;
}
export interface BroadcastRecord extends NormalizedBroadcast {
  id: string;
  channelId: string;
  missingCount: number;
  sourceUpdatedAt: Date | null;
}
export interface MappingRecord {
  id: string;
  userId: string;
  broadcastId: string;
  eventId: string;
  managedFieldsHash: string;
}
export interface SyncResult {
  status: 'RUNNING' | 'SUCCESS' | 'FAILED' | 'SKIPPED';
  message: string | null;
  errorCode?: string | null;
}
export type DeletionStep =
  'CALENDAR_DELETED' | 'TOKEN_REVOKED' | 'DATA_DELETED' | 'AUTH_DELETED' | 'COMPLETED';
export interface AccountDeletionRecord {
  id: string;
  supabaseUserId: string;
  userId: string | null;
  calendarIdSnapshot: string | null;
  status: string;
  lastErrorCode: string | null;
  calendarDeletedAt: Date | null;
  googleTokenRevokedAt: Date | null;
  userDataDeletedAt: Date | null;
  supabaseUserDeletedAt: Date | null;
  completedAt: Date | null;
}

export interface LeaseOwnership {
  key: string;
  ownerToken: string;
  version: number;
}

export type YouTubeQuotaBucket = 'GENERAL' | 'SEARCH';
export type YouTubeQuotaMode = 'MANUAL' | 'SCHEDULED';
export interface YouTubeRequestContext {
  mode: YouTubeQuotaMode;
  runId?: string;
}
export interface YouTubeQuotaReservation {
  granted: boolean;
  unitsUsed: number;
  unitsReserved: number;
  remaining: number;
}

export interface Store {
  findUserBySubject(subject: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  ensureUser(identity: AuthIdentity): Promise<UserRecord>;
  findAccountDeletion(subject: string): Promise<AccountDeletionRecord | null>;
  beginAccountDeletion(user: UserRecord): Promise<AccountDeletionRecord>;
  markAccountDeletionStep(
    id: string,
    step: DeletionStep,
    at: Date,
    lease: LeaseOwnership,
  ): Promise<boolean>;
  markAccountDeletionFailed(
    id: string,
    errorCode: string,
    at: Date,
    lease: LeaseOwnership,
  ): Promise<boolean>;
  saveCredential(userId: string, encryptedToken: string, keyId: string): Promise<void>;
  completeOnboarding(
    userId: string,
    encryptedToken: string,
    keyId: string,
    calendarId: string,
  ): Promise<UserRecord>;
  setCalendarId(userId: string, calendarId: string): Promise<void>;
  markReauthRequired(userId: string): Promise<void>;
  getEncryptedCredential(userId: string): Promise<string | null>;
  listSubscriptions(
    userId: string,
  ): Promise<Array<{ subscription: SubscriptionRecord; channel: ChannelRecord }>>;
  countSubscriptions(userId: string): Promise<number>;
  findChannelByYoutubeId(youtubeChannelId: string): Promise<ChannelRecord | null>;
  findChannelById(id: string): Promise<ChannelRecord | null>;
  upsertChannel(channel: ChannelSummary): Promise<ChannelRecord>;
  createSubscriptionWithinLimit(
    userId: string,
    channelId: string,
    limit: number,
  ): Promise<SubscriptionRecord>;
  getSubscription(
    userId: string,
    id: string,
  ): Promise<{ subscription: SubscriptionRecord; channel: ChannelRecord } | null>;
  updateSubscription(
    userId: string,
    id: string,
    status: SubscriptionStatus,
  ): Promise<SubscriptionRecord | null>;
  deleteSubscription(userId: string, id: string): Promise<void>;
  listActiveSubscriptions(): Promise<
    Array<{ subscription: SubscriptionRecord; channel: ChannelRecord; user: UserRecord }>
  >;
  updateChannelFetchedAt(channelId: string, at: Date): Promise<void>;
  upsertBroadcasts(
    channelId: string,
    items: NormalizedBroadcast[],
    observedAt: Date,
  ): Promise<BroadcastRecord[]>;
  listTrackableBroadcasts(channelId: string, now: Date): Promise<BroadcastRecord[]>;
  markBroadcastsUnavailable(
    channelId: string,
    youtubeVideoIds: string[],
    observedAt: Date,
  ): Promise<void>;
  listFutureBroadcasts(channelId: string, now: Date): Promise<BroadcastRecord[]>;
  listBroadcastsForSync(
    channelId: string,
    now: Date,
    since: Date | null,
  ): Promise<BroadcastRecord[]>;
  getMapping(userId: string, broadcastId: string): Promise<MappingRecord | null>;
  saveMapping(mapping: Omit<MappingRecord, 'id'>): Promise<MappingRecord>;
  deleteMapping(userId: string, broadcastId: string): Promise<void>;
  saveSyncResult(
    subscriptionId: string,
    result: SyncResult,
    at: Date,
    manual: boolean,
  ): Promise<void>;
  acquireSyncLease(
    key: string,
    ownerToken: string,
    now: Date,
    ttlMs: number,
  ): Promise<LeaseOwnership | null>;
  renewSyncLease(lease: LeaseOwnership, now: Date, ttlMs: number): Promise<boolean>;
  releaseSyncLease(lease: LeaseOwnership): Promise<boolean>;
  reserveYouTubeQuota(
    quotaDate: string,
    bucket: YouTubeQuotaBucket,
    units: number,
    dailyBudget: number,
    scheduledReserve: number,
    mode: YouTubeQuotaMode,
  ): Promise<YouTubeQuotaReservation>;
  consumeYouTubeQuota(quotaDate: string, bucket: YouTubeQuotaBucket, units: number): Promise<void>;
  startSyncRun(
    type: 'MANUAL' | 'SCHEDULED',
    requestedById: string | null,
    targets: number,
    at: Date,
  ): Promise<string>;
  startSyncTarget(runId: string, subscriptionId: string, at: Date): Promise<void>;
  finishSyncTarget(
    runId: string,
    subscriptionId: string,
    result: SyncResult,
    at: Date,
  ): Promise<void>;
  finishSyncRun(
    runId: string,
    status: 'SUCCESS' | 'PARTIAL_FAILED' | 'FAILED',
    at: Date,
    errorCode?: string,
  ): Promise<void>;
  maintainSyncRuns(staleBefore: Date, retainAfter: Date, at: Date): Promise<void>;
  deleteUserData(
    requestId: string,
    userId: string,
    at: Date,
    lease: LeaseOwnership,
  ): Promise<boolean>;
}

export interface YouTubeGateway {
  resolveHandle(handle: string, context?: YouTubeRequestContext): Promise<ChannelSummary>;
  listUpcoming(
    channel: ChannelRecord,
    from: Date,
    to: Date,
    context?: YouTubeRequestContext,
  ): Promise<NormalizedBroadcast[]>;
  refreshBroadcasts(
    channel: ChannelRecord,
    youtubeVideoIds: string[],
    context?: YouTubeRequestContext,
  ): Promise<{ items: NormalizedBroadcast[]; unavailableVideoIds: string[] }>;
}

export interface CalendarGateway {
  ensureCalendar(user: UserRecord): Promise<string>;
  eventExists(user: UserRecord, calendarId: string, eventId: string): Promise<boolean>;
  upsertEvent(
    user: UserRecord,
    calendarId: string,
    eventId: string | null,
    event: CalendarEventInput,
    deterministicId?: boolean,
  ): Promise<string>;
  deleteEvent(user: UserRecord, calendarId: string, eventId: string): Promise<void>;
  deleteCalendar(user: UserRecord, calendarId: string): Promise<void>;
  revokeAuthorization(user: UserRecord): Promise<void>;
}

export interface TokenCipher {
  encrypt(plaintext: string): { ciphertext: string; keyId: string };
  decrypt(ciphertext: string): string;
}
export interface Clock {
  now(): Date;
}
export interface AuthVerifier {
  verify(token: string): Promise<AuthIdentity>;
}
export interface AuthAdmin {
  deleteUser(subject: string): Promise<void>;
}
export interface AppLogger {
  info(data: Record<string, unknown>, message: string): void;
  error(data: Record<string, unknown>, message: string): void;
}
export type { BroadcastStatus };
