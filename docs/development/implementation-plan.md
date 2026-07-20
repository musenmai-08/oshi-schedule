# 実装計画

| Phase | 内容                                             | 状態 |
| ----- | ------------------------------------------------ | ---- |
| 1     | 要件・認証・同期・DB・API・security・test 設計   | 完了 |
| 2     | pnpm/Turbo、Web/API/worker/shared、Docker        | 完了 |
| 3     | Prisma schema/migration/seed/repository          | 完了 |
| 4     | Supabase/JWT/招待/暗号/初回設定                  | 完了 |
| 5     | handle 解決、登録、上限、停止、解除              | 完了 |
| 6     | YouTube/Calendar gateway、同期、worker、手動実行 | 完了 |
| 7     | MUI dashboard と状態 UI                          | 完了 |
| 8     | 再連携・account deletion                         | 完了 |
| 9     | unit/integration/E2E、型/lint/build、文書同期    | 完了 |

## ローカル受入

外部資格情報がある場合は real adapter、ない場合は `APP_MODE=fake` を利用する。Fake は同じ port と API 契約を通るため、画面だけのスタブにはしない。実装完了後、本表と README のコマンド・既知制約を更新する。

## 実装時検証（2026-07-20）

- Node.js は Supabase SDK のサポート方針に合わせ 22.23.1 LTS、pnpm は 9.15.9 に固定した。実行ホストの Node 20.12.2 でも検証できたが、正式な再現環境は `.nvmrc` を正とする。
- `pnpm typecheck`、`pnpm lint`、`pnpm test`（10 tests）、`pnpm build`、`pnpm test:e2e`（Chromium 1 scenario）が成功。
- Docker MySQL 8.4 が healthy になり、`prisma migrate deploy` と seed が成功。初期 migration と schema の diff も一致。
- `APP_MODE=fake pnpm sync:scheduled` が正常終了。
- 実 Supabase/Google/YouTube は資格情報がないため未接続。公開前に実環境で OAuth callback、refresh、失効、quota/error を検証する。
