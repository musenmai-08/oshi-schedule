import { describe, expect, it } from 'vitest';
import { loadPublicEnv } from './env';

const productionEnv = {
  NODE_ENV: 'production',
  NEXT_PUBLIC_API_URL: 'https://api.example.com',
  NEXT_PUBLIC_DEMO_MODE: 'false',
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
};

describe('Web public environment', () => {
  it('requires explicit deployment values and forbids demo mode in production', () => {
    expect(() => loadPublicEnv({ NODE_ENV: 'production' })).toThrow(/NEXT_PUBLIC_API_URL/);
    expect(() => loadPublicEnv({ ...productionEnv, NEXT_PUBLIC_DEMO_MODE: 'true' })).toThrow(
      /must be false/,
    );
    expect(() => loadPublicEnv({ ...productionEnv, NEXT_PUBLIC_SUPABASE_URL: undefined })).toThrow(
      /NEXT_PUBLIC_SUPABASE_URL/,
    );
  });

  it('rejects documented placeholders in production', () => {
    expect(() =>
      loadPublicEnv({
        ...productionEnv,
        NEXT_PUBLIC_SUPABASE_URL: 'https://your-project.supabase.co',
      }),
    ).toThrow(/placeholder/);
    expect(() =>
      loadPublicEnv({
        ...productionEnv,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_replace_me',
      }),
    ).toThrow(/placeholder/);
  });

  it('uses local defaults only outside production', () => {
    expect(loadPublicEnv({ NODE_ENV: 'test' })).toEqual({
      apiUrl: 'http://localhost:4000',
      demoMode: false,
      supabaseUrl: undefined,
      supabasePublishableKey: undefined,
    });
    expect(loadPublicEnv(productionEnv)).toMatchObject({
      apiUrl: 'https://api.example.com',
      demoMode: false,
    });
  });
});
