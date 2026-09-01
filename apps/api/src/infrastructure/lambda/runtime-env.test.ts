import { describe, expect, it, vi } from 'vitest';
import { loadLambdaRuntimeEnvironment } from './runtime-env.js';

describe('loadLambdaRuntimeEnvironment', () => {
  it('loads API-only and shared values without logging secret material', async () => {
    const source: NodeJS.ProcessEnv = {
      DATABASE_URL_SECRET_ARN: 'database',
      SUPABASE_SERVICE_ROLE_KEY_SECRET_ARN: 'supabase',
      GOOGLE_CLIENT_SECRET_SECRET_ARN: 'google',
      YOUTUBE_API_KEY_SECRET_ARN: 'youtube',
      TOKEN_ENCRYPTION_KEYS_SECRET_ARN: 'keys',
      ALLOWED_EMAILS_PARAMETER_NAME: '/allowed',
    };
    const getSecret = vi.fn(async (id: string) => `value-${id}`);
    const getParameter = vi.fn(async () => 'allowed@example.com');

    await loadLambdaRuntimeEnvironment('api', source, { getSecret, getParameter });

    expect(source).toMatchObject({
      DATABASE_URL: 'value-database',
      SUPABASE_SERVICE_ROLE_KEY: 'value-supabase',
      GOOGLE_CLIENT_SECRET: 'value-google',
      YOUTUBE_API_KEY: 'value-youtube',
      TOKEN_ENCRYPTION_KEYS: 'value-keys',
      ALLOWED_EMAILS: 'allowed@example.com',
    });
    expect(getSecret).toHaveBeenCalledTimes(5);
  });

  it('does not fetch API-only identity administration settings for the worker', async () => {
    const source: NodeJS.ProcessEnv = {
      DATABASE_URL_SECRET_ARN: 'database',
      GOOGLE_CLIENT_SECRET_SECRET_ARN: 'google',
      YOUTUBE_API_KEY_SECRET_ARN: 'youtube',
      TOKEN_ENCRYPTION_KEYS_SECRET_ARN: 'keys',
    };
    const getSecret = vi.fn(async (id: string) => `value-${id}`);

    await loadLambdaRuntimeEnvironment('worker', source, {
      getSecret,
      getParameter: vi.fn(),
    });

    expect(getSecret).toHaveBeenCalledTimes(4);
    expect(source.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    expect(source.ALLOWED_EMAILS).toBeUndefined();
  });
});
