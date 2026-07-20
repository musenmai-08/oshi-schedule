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
  lastSyncStatus: 'SUCCESS' | 'FAILED' | 'RUNNING' | null;
  lastErrorMessage: string | null;
}
export interface BroadcastRecord extends NormalizedBroadcast {
  id: string;
  channelId: string;
  missingCount: number;
}
export interface MappingRecord {
  id: string;
  userId: string;
  broadcastId: string;
  eventId: string;
  managedFieldsHash: string;
}
export interface SyncResult {
  status: 'SUCCESS' | 'FAILED';
  message: string | null;
}

export interface Store {
  findUserBySubject(subject: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  ensureUser(identity: AuthIdentity): Promise<UserRecord>;
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
  upsertChannel(channel: ChannelSummary): Promise<ChannelRecord>;
  createSubscription(userId: string, channelId: string): Promise<SubscriptionRecord>;
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
  upsertBroadcasts(channelId: string, items: NormalizedBroadcast[]): Promise<BroadcastRecord[]>;
  listFutureBroadcasts(channelId: string, now: Date): Promise<BroadcastRecord[]>;
  getMapping(userId: string, broadcastId: string): Promise<MappingRecord | null>;
  saveMapping(mapping: Omit<MappingRecord, 'id'>): Promise<MappingRecord>;
  deleteMapping(userId: string, broadcastId: string): Promise<void>;
  saveSyncResult(
    subscriptionId: string,
    result: SyncResult,
    at: Date,
    manual: boolean,
  ): Promise<void>;
  deleteAccount(userId: string): Promise<void>;
}

export interface YouTubeGateway {
  resolveHandle(handle: string): Promise<ChannelSummary>;
  listUpcoming(channel: ChannelRecord, from: Date, to: Date): Promise<NormalizedBroadcast[]>;
}

export interface CalendarGateway {
  ensureCalendar(user: UserRecord): Promise<string>;
  upsertEvent(
    user: UserRecord,
    calendarId: string,
    eventId: string | null,
    event: CalendarEventInput,
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
