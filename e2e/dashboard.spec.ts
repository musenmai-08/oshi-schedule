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
