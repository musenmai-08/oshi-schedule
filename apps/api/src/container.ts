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
}
export interface ContainerOverrides {
  store?: Store;
  auth?: AuthVerifier;
  youtube?: YouTubeGateway;
  calendar?: CalendarGateway;
  cipher?: TokenCipher;
  clock?: Clock;
  authAdmin?: AuthAdmin;
}

export function createContainer(env: Env, overrides: ContainerOverrides = {}): Container {
  const store =
    overrides.store ?? (env.APP_MODE === 'fake' ? new MemoryStore() : new PrismaStore());
  const cipher = overrides.cipher ?? new AesTokenCipher(env.TOKEN_ENCRYPTION_KEYS);
  const clock = overrides.clock ?? { now: () => new Date() };
  const youtube =
    overrides.youtube ??
    (env.APP_MODE === 'fake'
      ? new FakeYouTubeGateway()
      : new YouTubeDataGateway(env.YOUTUBE_API_KEY ?? ''));
  const calendar =
    overrides.calendar ??
    (env.APP_MODE === 'fake'
      ? new FakeCalendarGateway()
      : new GoogleCalendarGateway(
          store,
          cipher,
          env.GOOGLE_CLIENT_ID ?? '',
          env.GOOGLE_CLIENT_SECRET ?? '',
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
      : new SupabaseAuthAdmin(env.SUPABASE_URL ?? '', env.SUPABASE_SERVICE_ROLE_KEY ?? ''));
  const sync = new SyncService(store, youtube, calendar, clock, logger);
  const service = new OshiService(store, youtube, calendar, cipher, clock, authAdmin, sync);
  return { service, store, auth, invitation: new AllowedEmailInvitationPolicy(env.ALLOWED_EMAILS) };
}
