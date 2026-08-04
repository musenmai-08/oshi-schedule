import { AllowedEmailInvitationPolicy } from './domain/invitation.js';
import { OshiService } from './application/oshi-service.js';
import { SyncService } from './application/sync-service.js';
import type {
  AuthAdmin,
  AuthVerifier,
  CalendarGateway,
  Clock,
  Store,
  TokenCipher,
  YouTubeGateway,
} from './application/models.js';
import {
  FakeAuthAdmin,
  FakeAuthVerifier,
  SupabaseAuthAdmin,
  SupabaseAuthVerifier,
} from './infrastructure/auth/auth.js';
import { MemoryStore } from './infrastructure/database/memory-store.js';
import { PrismaStore } from './infrastructure/database/prisma-store.js';
import { AesTokenCipher } from './infrastructure/encryption/aes-token-cipher.js';
import { FakeCalendarGateway } from './infrastructure/google-calendar/fake-calendar-gateway.js';
import { GoogleCalendarGateway } from './infrastructure/google-calendar/google-calendar-gateway.js';
import { logger } from './infrastructure/logging/logger.js';
import { FakeYouTubeGateway } from './infrastructure/youtube/fake-youtube-gateway.js';
import { YouTubeDataGateway } from './infrastructure/youtube/youtube-data-gateway.js';
import type { Env } from './infrastructure/env.js';

export interface Container {
  service: OshiService;
  store: Store;
  auth: AuthVerifier;
  invitation: AllowedEmailInvitationPolicy;
  resources: RuntimeResources;
}
export interface RuntimeResources {
  checkReadiness(): Promise<void>;
  disconnect(): Promise<void>;
}
export interface ContainerOverrides {
  store?: Store;
  auth?: AuthVerifier;
  youtube?: YouTubeGateway;
  calendar?: CalendarGateway;
  cipher?: TokenCipher;
  clock?: Clock;
  authAdmin?: AuthAdmin;
  resources?: RuntimeResources;
}

export function createContainer(env: Env, overrides: ContainerOverrides = {}): Container {
  const store =
    overrides.store ?? (env.APP_MODE === 'fake' ? new MemoryStore(true) : new PrismaStore());
  const resources =
    overrides.resources ??
    (store instanceof PrismaStore
      ? {
          checkReadiness: () => store.checkReadiness(),
          disconnect: () => store.disconnect(),
        }
      : {
          checkReadiness: async () => undefined,
          disconnect: async () => undefined,
        });
  const cipher = overrides.cipher ?? new AesTokenCipher(env.TOKEN_ENCRYPTION_KEYS);
  const clock = overrides.clock ?? { now: () => new Date() };
  const youtube =
    overrides.youtube ??
    (env.APP_MODE === 'fake'
      ? new FakeYouTubeGateway()
      : new YouTubeDataGateway(
          env.YOUTUBE_API_KEY ?? '',
          env.EXTERNAL_API_TIMEOUT_MS,
          store,
          clock,
          logger,
          {
            dailyBudget: env.YOUTUBE_DAILY_QUOTA_BUDGET,
            dailySearchBudget: env.YOUTUBE_DAILY_SEARCH_QUOTA_BUDGET,
            scheduledReserve: env.YOUTUBE_SCHEDULED_QUOTA_RESERVE,
            scheduledSearchReserve: env.YOUTUBE_SCHEDULED_SEARCH_QUOTA_RESERVE,
            timeZone: env.YOUTUBE_QUOTA_TIMEZONE,
            maxSearchPages: env.YOUTUBE_MAX_SEARCH_PAGES,
            maxAttempts: env.YOUTUBE_API_MAX_ATTEMPTS,
            retryBaseDelayMs: env.YOUTUBE_RETRY_BASE_DELAY_MS,
            retryMaxDelayMs: env.YOUTUBE_RETRY_MAX_DELAY_MS,
          },
        ));
  const calendar =
    overrides.calendar ??
    (env.APP_MODE === 'fake'
      ? new FakeCalendarGateway()
      : new GoogleCalendarGateway(
          store,
          cipher,
          env.GOOGLE_CLIENT_ID ?? '',
          env.GOOGLE_CLIENT_SECRET ?? '',
          env.EXTERNAL_API_TIMEOUT_MS,
          undefined,
          env.OAUTH_RETRY_BASE_DELAY_MS,
          undefined,
          env.OAUTH_RETRY_MAX_DELAY_MS,
        ));
  const auth =
    overrides.auth ??
    (env.APP_MODE === 'fake'
      ? new FakeAuthVerifier()
      : new SupabaseAuthVerifier(env.SUPABASE_URL ?? '', env.SUPABASE_JWT_AUDIENCE));
  const authAdmin =
    overrides.authAdmin ??
    (env.APP_MODE === 'fake'
      ? new FakeAuthAdmin()
      : new SupabaseAuthAdmin(
          env.SUPABASE_URL ?? '',
          env.SUPABASE_SERVICE_ROLE_KEY ?? '',
          env.EXTERNAL_API_TIMEOUT_MS,
        ));
  const sync = new SyncService(store, youtube, calendar, clock, logger, env.SYNC_LEASE_MS, {
    maxTrackedBroadcastsPerChannel: env.YOUTUBE_MAX_TRACKED_BROADCASTS_PER_CHANNEL,
    trackingWindowDays: env.YOUTUBE_TRACKING_WINDOW_DAYS,
    snapshotWaitMs: Math.min(env.SYNC_LEASE_MS, 30_000),
    snapshotPollMs: 250,
  });
  const service = new OshiService(
    store,
    youtube,
    calendar,
    cipher,
    clock,
    authAdmin,
    sync,
    env.ACCOUNT_DELETION_LEASE_MS,
  );
  return {
    service,
    store,
    auth,
    invitation: new AllowedEmailInvitationPolicy(env.ALLOWED_EMAILS),
    resources,
  };
}
