import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: 'html',
  use: { baseURL: 'http://127.0.0.1:3000', trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @oshi-schedule/api dev',
      url: 'http://127.0.0.1:4000/health',
      reuseExistingServer: !process.env.CI,
      env: {
        APP_MODE: 'fake',
        NODE_ENV: 'test',
        ALLOWED_EMAILS: 'developer@example.com',
        WEB_ORIGIN: 'http://127.0.0.1:3000',
      },
    },
    {
      command: 'pnpm --filter @oshi-schedule/web dev',
      url: 'http://127.0.0.1:3000',
      reuseExistingServer: !process.env.CI,
      env: { NEXT_PUBLIC_DEMO_MODE: 'true', NEXT_PUBLIC_API_URL: 'http://127.0.0.1:4000' },
    },
  ],
});
