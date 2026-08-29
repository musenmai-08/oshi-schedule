import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { decodeEncryptionKey, isPredictableEncryptionKey } from './encryption/aes-token-cipher.js';
import { calculateYouTubeDailyQuotaBounds } from './youtube/youtube-quota.js';

export const ROOT_ENV_PATH = fileURLToPath(new URL('../../../../.env', import.meta.url));
loadDotenv({ path: ROOT_ENV_PATH, quiet: true });

export const DEVELOPMENT_TOKEN_ENCRYPTION_KEYS = 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const timeZone = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, 'Invalid IANA time zone');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_MODE: z.enum(['fake', 'real']).default('fake'),
    PORT: z.coerce.number().int().positive().default(4000),
    WEB_ORIGIN: z.string().url().default('http://localhost:3001'),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
    SHUTDOWN_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(300).default(30),
    DATABASE_URL: z.string().optional(),
    ALLOWED_EMAILS: z.string().default('developer@example.com'),
    SUPABASE_URL: z.string().url().optional(),
    SUPABASE_JWT_AUDIENCE: z.string().default('authenticated'),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
    SYNC_JOB_QUEUE_URL: z.string().url().optional(),
    YOUTUBE_API_KEY: z.string().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    TOKEN_ENCRYPTION_KEYS: z.string().default(DEVELOPMENT_TOKEN_ENCRYPTION_KEYS),
    EXTERNAL_API_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
    ACCOUNT_DELETION_LEASE_MS: z.coerce.number().int().min(1_000).default(60_000),
    SYNC_LEASE_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .default(15 * 60_000),
    OAUTH_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(1).default(1_000),
    OAUTH_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(1).default(5_000),
    YOUTUBE_DAILY_QUOTA_BUDGET: z.coerce.number().int().positive().default(8_000),
    YOUTUBE_DAILY_SEARCH_QUOTA_BUDGET: z.coerce.number().int().positive().default(80),
    YOUTUBE_SCHEDULED_QUOTA_RESERVE: z.coerce.number().int().nonnegative().default(432),
    YOUTUBE_SCHEDULED_SEARCH_QUOTA_RESERVE: z.coerce.number().int().nonnegative().default(72),
    YOUTUBE_QUOTA_TIMEZONE: timeZone.default('America/Los_Angeles'),
    YOUTUBE_MAX_SEARCH_PAGES: z.coerce.number().int().min(1).max(10).default(1),
    YOUTUBE_MAX_TRACKED_BROADCASTS_PER_CHANNEL: z.coerce.number().int().min(1).max(250).default(50),
    YOUTUBE_TRACKING_WINDOW_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    YOUTUBE_API_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(3).default(3),
    YOUTUBE_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(1).default(1_000),
    YOUTUBE_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(1).default(5_000),
  })
  .superRefine((env, context) => {
    const quota = calculateYouTubeDailyQuotaBounds({
      maxSearchPages: env.YOUTUBE_MAX_SEARCH_PAGES,
      maxTrackedBroadcastsPerChannel: env.YOUTUBE_MAX_TRACKED_BROADCASTS_PER_CHANNEL,
      maxAttempts: env.YOUTUBE_API_MAX_ATTEMPTS,
    });
    const maximumCalendarDeletionMs =
      env.EXTERNAL_API_TIMEOUT_MS * 4 + env.OAUTH_RETRY_MAX_DELAY_MS * 2;
    if (env.ACCOUNT_DELETION_LEASE_MS <= maximumCalendarDeletionMs)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ACCOUNT_DELETION_LEASE_MS'],
        message: 'ACCOUNT_DELETION_LEASE_MS must exceed the maximum bounded deletion call',
      });
    if (env.SYNC_LEASE_MS <= env.EXTERNAL_API_TIMEOUT_MS)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SYNC_LEASE_MS'],
        message: 'SYNC_LEASE_MS must exceed EXTERNAL_API_TIMEOUT_MS',
      });
    if (env.YOUTUBE_SCHEDULED_QUOTA_RESERVE > env.YOUTUBE_DAILY_QUOTA_BUDGET)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['YOUTUBE_SCHEDULED_QUOTA_RESERVE'],
        message: 'scheduled quota reserve must not exceed daily budget',
      });
    if (env.YOUTUBE_SCHEDULED_SEARCH_QUOTA_RESERVE > env.YOUTUBE_DAILY_SEARCH_QUOTA_BUDGET)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['YOUTUBE_SCHEDULED_SEARCH_QUOTA_RESERVE'],
        message: 'scheduled search reserve must not exceed daily search budget',
      });
    if (env.YOUTUBE_SCHEDULED_QUOTA_RESERVE < quota.scheduledGeneralWithRetries)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['YOUTUBE_SCHEDULED_QUOTA_RESERVE'],
        message: `scheduled quota reserve must be at least ${quota.scheduledGeneralWithRetries}`,
      });
    if (env.YOUTUBE_SCHEDULED_SEARCH_QUOTA_RESERVE < quota.scheduledSearchWithoutRetries)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['YOUTUBE_SCHEDULED_SEARCH_QUOTA_RESERVE'],
        message: `scheduled search reserve must be at least ${quota.scheduledSearchWithoutRetries}`,
      });
  });
export type Env = z.infer<typeof schema>;
export type RuntimeKind = 'api' | 'worker';

export function loadEnv(source: NodeJS.ProcessEnv = process.env, runtime: RuntimeKind = 'api'): Env {
  const env = schema.parse(source);
  if (env.NODE_ENV === 'production' || env.APP_MODE === 'real') {
    if (!source.WEB_ORIGIN?.trim())
      throw new Error('Missing required environment variable: WEB_ORIGIN');
    if (runtime === 'api' && !source.ALLOWED_EMAILS?.trim())
      throw new Error('Missing required environment variable: ALLOWED_EMAILS');
    if (env.NODE_ENV === 'production') {
      const webOrigin = new URL(env.WEB_ORIGIN);
      if (
        webOrigin.protocol !== 'https:' ||
        webOrigin.username !== '' ||
        webOrigin.password !== '' ||
        webOrigin.pathname !== '/' ||
        webOrigin.search !== '' ||
        webOrigin.hash !== ''
      )
        throw new Error('WEB_ORIGIN must be an HTTPS origin in production');
    }
    if (
      runtime === 'api' &&
      env.ALLOWED_EMAILS.split(',').some(
        (email) => email.trim().toLowerCase() === 'developer@example.com',
      )
    )
      throw new Error('ALLOWED_EMAILS must not use the development default in production/real');
    for (const key of [
      'DATABASE_URL',
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'YOUTUBE_API_KEY',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
    ] as const) {
      if (!env[key]) throw new Error(`Missing required environment variable: ${key}`);
    }
    if (env.NODE_ENV === 'production' && !env.SYNC_JOB_QUEUE_URL)
      throw new Error('Missing required environment variable: SYNC_JOB_QUEUE_URL');
    if (env.APP_MODE === 'fake') throw new Error('Fake mode is forbidden in production');
    for (const entry of env.TOKEN_ENCRYPTION_KEYS.split(',')) {
      const separator = entry.indexOf(':');
      if (separator <= 0) throw new Error('TOKEN_ENCRYPTION_KEYS must contain a key identifier');
      const key = decodeEncryptionKey(entry.slice(separator + 1));
      if (isPredictableEncryptionKey(key))
        throw new Error(
          'TOKEN_ENCRYPTION_KEYS must not use a known, predictable, low-entropy, or unsafe key',
        );
    }
  }
  return env;
}

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return loadEnv(source, 'worker');
}
