import { defineConfig, devices } from '@playwright/test';

const webPort = Number(process.env.E2E_WEB_PORT ?? 3310);
const apiPort = Number(process.env.E2E_API_PORT ?? 4310);
const webOrigin = `http://127.0.0.1:${webPort}`;
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const e2eSupabaseUrl = 'https://supabase.e2e.example.invalid';
const e2eSupabasePublishableKey = 'sb_publishable_e2e_only_not_a_secret';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'html',
  use: { baseURL: webOrigin, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @oshi-schedule/api exec tsx src/server.ts',
      url: `${apiOrigin}/health`,
      reuseExistingServer: false,
      env: {
        APP_MODE: 'fake',
        NODE_ENV: 'test',
        PORT: String(apiPort),
        ALLOWED_EMAILS: 'developer@example.com',
        WEB_ORIGIN: webOrigin,
      },
    },
    {
      command: `pnpm --filter @oshi-schedule/web exec next dev -p ${webPort}`,
      url: webOrigin,
      reuseExistingServer: false,
      env: {
        NEXT_PUBLIC_DEMO_MODE: 'true',
        NEXT_PUBLIC_API_URL: apiOrigin,
        NEXT_PUBLIC_SUPABASE_URL: e2eSupabaseUrl,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: e2eSupabasePublishableKey,
      },
    },
  ],
});
