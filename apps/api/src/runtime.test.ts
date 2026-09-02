import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createWorkerRuntime } from './runtime.js';

describe('worker runtime environment contract', () => {
  it('starts in real mode without API-only dispatch and identity settings', async () => {
    const runtime = createWorkerRuntime({
      NODE_ENV: 'production',
      APP_MODE: 'real',
      DATABASE_URL:
        'postgresql://user:password@localhost:5432/test?schema=app&sslmode=require&pgbouncer=true&connection_limit=1',
      YOUTUBE_API_KEY: 'youtube-key',
      GOOGLE_CLIENT_ID: 'client-id',
      GOOGLE_CLIENT_SECRET: 'client-secret',
      TOKEN_ENCRYPTION_KEYS: `v1:${randomBytes(32).toString('base64')}`,
    });

    expect(runtime.env.APP_MODE).toBe('real');
    await runtime.disconnect();
  });
});
