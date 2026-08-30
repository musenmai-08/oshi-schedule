import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Google でログイン' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText('最初の推しを登録しましょう')).toBeVisible();
}

test('チャンネルの登録から同期・停止・削除まで操作できる', async ({ page, request }) => {
  const apiPort = Number(process.env.E2E_API_PORT ?? 4310);
  const health = await request.get(`http://127.0.0.1:${apiPort}/health`);
  expect(health.ok()).toBe(true);
  expect(await health.json()).toMatchObject({
    data: { status: 'ok', service: 'oshi-schedule-api' },
  });
  await login(page);
  await expect(page.getByRole('heading', { name: 'おかえりなさい' })).toBeVisible();
  await page.getByRole('button', { name: 'チャンネルを追加' }).first().click();
  await page.getByLabel('YouTube @handle').fill('@playwright');
  await page.getByRole('button', { name: '検索' }).click();
  await expect(page.getByText('@playwright', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'このチャンネルを登録' }).click();
  await expect(page.getByText('初回同期が完了しました')).toBeVisible();
  await expect(page.getByText('playwright チャンネル')).toBeVisible();
  await page.getByLabel('playwright チャンネルを一時停止').click();
  await expect(page.getByText('一時停止', { exact: true })).toBeVisible();
  await page.getByLabel('playwright チャンネルを再開').click();
  await page.getByLabel('playwright チャンネルを今すぐ同期').click();
  await expect(page.getByText('同期が完了しました')).toBeVisible();
  page.on('dialog', (dialog) => dialog.accept());
  await page.getByLabel('playwright チャンネルの登録を解除').click();
  await expect(page.getByText('最初の推しを登録しましょう')).toBeVisible();
});

test('チャンネル追加エラーをモーダル内で表示し再試行と閉じる操作で解除する', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'チャンネルを追加' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'チャンネルを追加' });

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
  await dialog.getByRole('button', { name: '検索' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveText(/YouTubeチャンネルが見つかりません/);
  await expect(dialog).not.toContainText('内部メッセージ');

  await page.unroute('**/api/v1/channels/resolve');
  await page.getByLabel('YouTube @handle').fill('@retryable');
  await dialog.getByRole('button', { name: '検索' }).click();
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
  await dialog.getByRole('button', { name: 'このチャンネルを登録' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveText('このチャンネルはすでに登録されています。');

  await dialog.getByRole('button', { name: 'キャンセル' }).click();
  await page.getByRole('button', { name: 'チャンネルを追加' }).first().click();
  await expect(page.getByRole('dialog').getByRole('alert')).not.toBeVisible();
  await page.getByLabel('YouTube @handle').fill('invalid');
  await page.getByRole('dialog').getByRole('button', { name: '検索' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('@から始まる3〜30文字');
});

test('チャンネル登録上限をモーダル内で表示する', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'チャンネルを追加' }).first().click();
  const dialog = page.getByRole('dialog');
  await page.getByLabel('YouTube @handle').fill('@limitcase');
  await dialog.getByRole('button', { name: '検索' }).click();
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
  await dialog.getByRole('button', { name: 'このチャンネルを登録' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('登録できるチャンネルは3件までです。');
});

test('認証済みルート遷移とログアウト後のルート保護', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /推しの予定を/ })).toBeVisible();
  await page.getByRole('button', { name: 'Google でログイン' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.goto('/');
  await expect(page).toHaveURL(/\/dashboard$/);
  const logout = page.getByRole('button', { name: 'ログアウト' });
  await logout.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('button', { name: 'Google でログイン' })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'おかえりなさい' })).not.toBeVisible();
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/$/);
});

test('未認証で利用規約とプライバシーポリシーを表示できる', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: '利用規約' }).click();
  await expect(page).toHaveURL(/\/terms$/);
  await expect(page.getByRole('heading', { level: 1, name: '利用規約' })).toBeVisible();
  await expect(page.getByText(/13歳以上の方を対象/)).toBeVisible();
  await page.getByRole('link', { name: 'ログイン画面に戻る' }).click();

  await page.getByRole('link', { name: 'プライバシー' }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole('heading', { level: 1, name: 'プライバシーポリシー' })).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 2, name: /Google API Services User Data Policy/ }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'ログイン画面に戻る' })).toBeVisible();
});

test('Settingsから認証状態を維持してダッシュボードへ戻れる', async ({ page }) => {
  await login(page);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'アカウント設定' })).toBeVisible();
  await page.getByRole('link', { name: 'ダッシュボードに戻る' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'おかえりなさい' })).toBeVisible();
});

test('callbackの固定エラーだけを表示してqueryをURLから除去する', async ({ page }) => {
  await login(page);

  await page.goto('/dashboard?setup=failed');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Google Calendarの初回設定に失敗しました' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Googleを再連携' })).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.goto('/dashboard?setup=reauth');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Googleの再同意が必要です' }),
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
    page.getByRole('alert').filter({ hasText: 'Googleの再連携が必要です' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Googleを再連携' })).toBeVisible();
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
  await page.getByRole('button', { name: 'Google でログイン' }).click();
  await page.goto('/settings');
  await expect(page.getByText('確認中', { exact: true })).toBeVisible();
  await expect(page.getByText('接続済み', { exact: true })).not.toBeVisible();
  releaseResponse?.();
  await expect(page.getByText('取得失敗', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: '通信状態を確認して' })).toBeVisible();

  await page.unroute('**/api/v1/me');
  await page.reload();
  await expect(page.getByText('接続済み', { exact: true })).toBeVisible();
  await expect(page.getByText('推しスケジュール（有効）')).toBeVisible();
});
