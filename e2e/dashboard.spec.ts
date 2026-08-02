import { expect, test } from '@playwright/test';

test('チャンネルの登録から同期・停止・削除まで操作できる', async ({ page, request }) => {
  const apiPort = Number(process.env.E2E_API_PORT ?? 4310);
  const health = await request.get(`http://127.0.0.1:${apiPort}/health`);
  expect(health.ok()).toBe(true);
  expect(await health.json()).toMatchObject({
    data: { status: 'ok', service: 'oshi-schedule-api' },
  });
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'おかえりなさい' })).toBeVisible();
  await page.getByRole('button', { name: 'チャンネルを追加' }).first().click();
  await page.getByLabel('YouTube @handle').fill('@playwright');
  await page.getByRole('button', { name: '検索' }).click();
  await expect(page.getByText('@playwright', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'このチャンネルを登録' }).click();
  await expect(page.getByText('チャンネルを登録し、初回同期が完了しました')).toBeVisible();
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
  await page.goto('/dashboard');
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
  await page.goto('/dashboard');
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
