import { z } from 'zod';

export const APP_NAME = '推しスケジュール';
export const MAX_CHANNELS_PER_USER = 3;
export const SYNC_LOOKAHEAD_DAYS = 30;
export const MANUAL_SYNC_COOLDOWN_SECONDS = 300;
export const entityIdSchema = z.string().cuid();

export const channelHandleSchema = z
  .string()
  .trim()
  .regex(/^@[A-Za-z0-9._-]{3,30}$/, '@から始まる3〜30文字のハンドルを入力してください');
export const resolveChannelSchema = z.object({ handle: channelHandleSchema });
export const createChannelSchema = z.object({ youtubeChannelId: z.string().min(1) });
export const updateSubscriptionSchema = z.object({ status: z.enum(['ACTIVE', 'PAUSED']) });
export const onboardingSchema = z.object({
  providerRefreshToken: z.string().min(1),
  providerAccessToken: z.string().min(1).optional(),
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
  lastSyncStatus: 'SUCCESS' | 'FAILED' | 'RUNNING' | 'SKIPPED' | null;
  lastErrorMessage: string | null;
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
