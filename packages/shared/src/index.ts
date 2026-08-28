import { z } from 'zod';

export const APP_NAME = '推しスケジュール';
export const MAX_CHANNELS_PER_USER = 3;
export const SYNC_LOOKAHEAD_DAYS = 30;
export const MANUAL_SYNC_COOLDOWN_SECONDS = 300;
export const entityIdSchema = z.string().cuid();

export const GOOGLE_OPENID_SCOPE = 'openid';
export const GOOGLE_USERINFO_EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';
export const GOOGLE_USERINFO_PROFILE_SCOPE = 'https://www.googleapis.com/auth/userinfo.profile';
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
export const GOOGLE_OAUTH_REQUEST_SCOPES = [
  GOOGLE_OPENID_SCOPE,
  GOOGLE_USERINFO_EMAIL_SCOPE,
  GOOGLE_USERINFO_PROFILE_SCOPE,
  GOOGLE_CALENDAR_SCOPE,
] as const;

const GOOGLE_CALENDAR_SCOPE_PREFIX = 'https://www.googleapis.com/auth/calendar';
const EMAIL_SCOPE_ALIASES = new Set(['email', GOOGLE_USERINFO_EMAIL_SCOPE]);
const PROFILE_SCOPE_ALIASES = new Set(['profile', GOOGLE_USERINFO_PROFILE_SCOPE]);

export interface GoogleScopeValidation {
  valid: boolean;
  scopes: string[];
  serialized: string;
  missing: Array<'openid' | 'userinfo.email' | 'userinfo.profile' | 'calendar.app.created'>;
  unexpectedCalendarScopes: string[];
}

export function validateGoogleGrantedScopes(
  value: string | null | undefined,
): GoogleScopeValidation {
  const scopes = [...new Set((value ?? '').split(/\s+/).filter(Boolean))].sort();
  const granted = new Set(scopes);
  const missing: GoogleScopeValidation['missing'] = [];
  if (!granted.has(GOOGLE_OPENID_SCOPE)) missing.push('openid');
  if (!scopes.some((scope) => EMAIL_SCOPE_ALIASES.has(scope))) missing.push('userinfo.email');
  if (!scopes.some((scope) => PROFILE_SCOPE_ALIASES.has(scope))) missing.push('userinfo.profile');
  if (!granted.has(GOOGLE_CALENDAR_SCOPE)) missing.push('calendar.app.created');
  const unexpectedCalendarScopes = scopes.filter(
    (scope) => scope.startsWith(GOOGLE_CALENDAR_SCOPE_PREFIX) && scope !== GOOGLE_CALENDAR_SCOPE,
  );
  return {
    valid: missing.length === 0 && unexpectedCalendarScopes.length === 0,
    scopes,
    serialized: scopes.join(' '),
    missing,
    unexpectedCalendarScopes,
  };
}

export const channelHandleSchema = z
  .string()
  .trim()
  .regex(/^@[A-Za-z0-9._-]{3,30}$/, '@から始まる3〜30文字のハンドルを入力してください');
export const resolveChannelSchema = z.object({ handle: channelHandleSchema });
export const createChannelSchema = z.object({ youtubeChannelId: z.string().min(1) });
export const updateSubscriptionSchema = z.object({ status: z.enum(['ACTIVE', 'PAUSED']) });
export const onboardingSchema = z.object({
  providerRefreshToken: z.string().min(1),
});
export const reconnectSchema = onboardingSchema;
export const deleteAccountSchema = z.object({ confirmation: z.literal('DELETE') });

export type SubscriptionStatus = 'ACTIVE' | 'PAUSED';
export type BroadcastKind = 'LIVE' | 'PREMIERE' | 'UNKNOWN';
export type BroadcastStatus = 'UPCOMING' | 'LIVE' | 'COMPLETED' | 'CANCELLED' | 'UNAVAILABLE';

export interface ChannelSummary {
  id: string;
  youtubeChannelId: string;
  title: string;
  handle: string;
  thumbnailUrl: string;
  channelUrl: string;
}

export interface SubscriptionView extends ChannelSummary {
  subscriptionId: string;
  status: SubscriptionStatus;
  lastFetchedAt: string | null;
  lastCalendarSyncAt: string | null;
  lastSyncStatus: 'QUEUED' | 'SUCCESS' | 'FAILED' | 'RUNNING' | 'SKIPPED' | 'DEFERRED' | null;
  lastErrorMessage: string | null;
}

export interface ChannelRegistrationResult {
  subscription: {
    id: string;
    status: SubscriptionStatus;
  };
  sync: {
    id: string;
    subscriptionId: string;
    status: 'QUEUED' | 'RUNNING' | 'FAILED';
    errorCode?: string;
  };
}

export type SyncRunStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCESS'
  | 'FAILED'
  | 'DEFERRED'
  | 'PARTIAL_SUCCESS'
  | 'PARTIAL_FAILED'
  | 'SKIPPED';

export interface SyncRunAccepted {
  id: string;
  subscriptionId: string;
  status: 'QUEUED' | 'RUNNING';
}

export interface SyncRunView {
  id: string;
  subscriptionId: string;
  trigger: 'INITIAL' | 'MANUAL';
  status: SyncRunStatus;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: { code: string; message: string | null } | null;
  result: {
    youtubeFetch: 'NOT_STARTED' | 'SUCCESS' | 'DEFERRED' | 'FAILED' | 'SKIPPED';
    databaseUpdate: 'NOT_STARTED' | 'SUCCESS' | 'DEFERRED' | 'FAILED' | 'SKIPPED';
    calendarSync: 'NOT_STARTED' | 'SUCCESS' | 'DEFERRED' | 'FAILED' | 'SKIPPED';
    snapshotVersion: number | null;
  };
}

export interface MeView {
  id: string;
  email: string;
  onboardingCompleted: boolean;
  reauthRequired: boolean;
  calendarStatus: 'NOT_CONNECTED' | 'ACTIVE' | 'MISSING' | 'ERROR';
}

export interface ApiSuccess<T> {
  data: T;
  requestId: string;
}
export interface ApiFailure {
  error: { code: string; message: string; details?: unknown };
  requestId: string;
}
