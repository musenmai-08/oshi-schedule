import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createWorkerRuntime } from './runtime.js';

describe('worker runtime environment contract', () => {
  it('starts in real mode without the API-only ALLOWED_EMAILS setting', async () => {
    const runtime = createWorkerRuntime({
      NODE_ENV: 'production',
      APP_MODE: 'real',
      WEB_ORIGIN: 'https://staging.oshi-schedule.com',
      DATABASE_URL: 'mysql://user:password@localhost:3306/test',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role',
      YOUTUBE_API_KEY: 'youtube-key',
      GOOGLE_CLIENT_ID: 'client-id',
      GOOGLE_CLIENT_SECRET: 'client-secret',
      SYNC_JOB_QUEUE_URL: 'https://sqs.ap-northeast-1.amazonaws.com/111111111111/sync-jobs',
      TOKEN_ENCRYPTION_KEYS: `v1:${randomBytes(32).toString('base64')}`,
    });

    expect(runtime.env.APP_MODE).toBe('real');
    await runtime.disconnect();
  });
});
