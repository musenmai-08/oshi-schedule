import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in with Google' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText('Add your first channel')).toBeVisible();
}

test('チャンネルの登録から同期・停止・削除まで操作できる', async ({ page, request }) => {
  const apiPort = Number(process.env.E2E_API_PORT ?? 4310);
  const health = await request.get(`http://127.0.0.1:${apiPort}/health`);
  expect(health.ok()).toBe(true);
  expect(await health.json()).toMatchObject({
    data: { status: 'ok', service: 'oshi-schedule-api' },
  });
  await login(page);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await page.getByRole('button', { name: 'Add Channel' }).first().click();
  await page.getByLabel('YouTube @handle').fill('@playwright');
  await page.getByRole('button', { name: 'Find Channel' }).click();
  await expect(page.getByText('@playwright', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add This Channel' }).click();
  await expect(
    page.getByText('Initial sync to Google Calendar completed successfully.'),
  ).toBeVisible();
  await expect(page.getByText('playwright チャンネル')).toBeVisible();
  await page.getByLabel('Pause playwright チャンネル').click();
  await expect(page.getByText('Paused', { exact: true })).toBeVisible();
  await page.getByLabel('Resume playwright チャンネル').click();
  await page.getByLabel('Sync playwright チャンネル again').click();
  await expect(page.getByText('Successfully synced to Google Calendar.')).toBeVisible();
  page.on('dialog', (dialog) => dialog.accept());
  await page.getByLabel('Remove playwright チャンネル').click();
  await expect(page.getByText('Add your first channel')).toBeVisible();
});

test('チャンネル追加エラーをモーダル内で表示し再試行と閉じる操作で解除する', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Add Channel' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add Channel' });

  await page.getByLabel('YouTube @handle').fill('@missing');
  await page.route('**/api/v1/channels/resolve', async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'CHANNEL_NOT_FOUND', message: '内部メッセージ' },
        requestId: 'e2e-request',
      }),
    });
  });
  await dialog.getByRole('button', { name: 'Find Channel' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveText(/No matching YouTube channel was found/);
  await expect(dialog).not.toContainText('内部メッセージ');

  await page.unroute('**/api/v1/channels/resolve');
  await page.getByLabel('YouTube @handle').fill('@retryable');
  await dialog.getByRole('button', { name: 'Find Channel' }).click();
  await expect(dialog.getByRole('alert')).not.toBeVisible();
  await expect(dialog.getByText('@retryable', { exact: true })).toBeVisible();

  await page.route('**/api/v1/channels', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'DUPLICATE_CHANNEL', message: '内部メッセージ' },
        requestId: 'e2e-request',
      }),
    });
  });
  await dialog.getByRole('button', { name: 'Add This Channel' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveText('This channel is already registered.');

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Add Channel' }).first().click();
  await expect(page.getByRole('dialog').getByRole('alert')).not.toBeVisible();
  await page.getByLabel('YouTube @handle').fill('invalid');
  await page.getByRole('dialog').getByRole('button', { name: 'Find Channel' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
    '3–30 character handle beginning with @',
  );
});

test('チャンネル登録上限をモーダル内で表示する', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Add Channel' }).first().click();
  const dialog = page.getByRole('dialog');
  await page.getByLabel('YouTube @handle').fill('@limitcase');
  await dialog.getByRole('button', { name: 'Find Channel' }).click();
  await expect(dialog.getByText('@limitcase', { exact: true })).toBeVisible();
  await page.route('**/api/v1/channels', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'CHANNEL_LIMIT_REACHED', message: '内部メッセージ' },
        requestId: 'e2e-request',
      }),
    });
  });
  await dialog.getByRole('button', { name: 'Add This Channel' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('You can register up to 3 channels.');
});

test('認証済みルート遷移とログアウト後のルート保護', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Never miss your/ })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in with Google' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.goto('/');
  await expect(page).toHaveURL(/\/dashboard$/);
  const logout = page.getByRole('button', { name: 'Sign Out' });
  await logout.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).not.toBeVisible();
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/$/);
});

test('未認証で利用規約とプライバシーポリシーを表示できる', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Terms of Service' }).click();
  await expect(page).toHaveURL(/\/terms$/);
  await expect(page.getByRole('heading', { level: 1, name: '利用規約' })).toBeVisible();
  await expect(page.getByText(/13歳以上の方を対象/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'YouTube利用規約' })).toHaveAttribute(
    'href',
    'https://www.youtube.com/t/terms',
  );
  await page.getByRole('link', { name: 'ログイン画面に戻る' }).click();

  await page.getByRole('link', { name: 'Privacy Policy' }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole('heading', { level: 1, name: 'プライバシーポリシー' })).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 2, name: /Google API Services User Data Policy/ }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Googleプライバシーポリシー' })).toHaveAttribute(
    'href',
    'https://www.google.com/policies/privacy',
  );
  await expect(
    page.getByRole('link', { name: 'Googleアカウントのサードパーティとの接続' }),
  ).toHaveAttribute('href', 'https://myaccount.google.com/connections?filters=3,4&hl=en');
  await expect(page.getByRole('link', { name: 'ログイン画面に戻る' })).toBeVisible();
});

test('Settingsから認証状態を維持してダッシュボードへ戻れる', async ({ page }) => {
  await login(page);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'アカウント設定' })).toBeVisible();
  await page.getByRole('link', { name: 'ダッシュボードに戻る' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
});

test('callbackの固定エラーだけを表示してqueryをURLから除去する', async ({ page }) => {
  await login(page);

  await page.goto('/dashboard?setup=failed');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Google Calendar setup failed' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reconnect Google' })).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.goto('/dashboard?setup=reauth');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Google authorization is required again' }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.goto('/dashboard?setup=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E');
  await expect(page.getByText('<img src=x onerror=alert(1)>')).not.toBeVisible();
  await expect(page).toHaveURL(/\/dashboard$/);
});

test('APIの再認証状態をダッシュボードに表示する', async ({ page }) => {
  await page.route('**/api/v1/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: 'anonymous-e2e-user',
          email: 'masked@example.com',
          onboardingCompleted: true,
          reauthRequired: true,
          calendarStatus: 'ACTIVE',
        },
        requestId: 'e2e-request',
      }),
    });
  });
  await login(page);
  await expect(
    page.getByRole('alert').filter({ hasText: 'Google reconnection required' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reconnect Google' })).toBeVisible();
});

test('Settingsの読み込み中・失敗・正常な接続状態を区別する', async ({ page }) => {
  let releaseResponse: (() => void) | undefined;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route('**/api/v1/me', async (route) => {
    await responseGate;
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in with Google' }).click();
  await page.goto('/settings');
  await expect(page.getByText('Checking', { exact: true })).toBeVisible();
  await expect(page.getByText('Connected', { exact: true })).not.toBeVisible();
  releaseResponse?.();
  await expect(page.getByText('Unavailable', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Check your connection' })).toBeVisible();

  await page.unroute('**/api/v1/me');
  await page.reload();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  await expect(page.getByText('Oshi Schedule (active)')).toBeVisible();
});
