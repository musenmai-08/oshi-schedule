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
| 10    | 再監査残件、fencing、quota budget、再回帰検証    | 完了 |

## ローカル受入

外部資格情報がある場合は real adapter、ない場合は `APP_MODE=fake` を利用する。Fake は同じ port と API 契約を通るため、画面だけのスタブにはしない。実装完了後、本表と README のコマンド・既知制約を更新する。

## 実装時検証（2026-07-20）

- Node.js は Supabase SDK のサポート方針に合わせ 22.23.1 LTS、pnpm は 9.15.9 に固定した。実行ホストの Node 20.12.2 でも検証できたが、正式な再現環境は `.nvmrc` を正とする。
- `pnpm typecheck`、`pnpm lint`、`pnpm test`（10 tests）、`pnpm build`、`pnpm test:e2e`（Chromium 1 scenario）が成功。
- Docker MySQL 8.4 が healthy になり、`prisma migrate deploy` と seed が成功。初期 migration と schema の diff も一致。
- `APP_MODE=fake pnpm sync:scheduled` が正常終了。
- 当時は実 Supabase/Google/YouTube が未接続だった。2026-08-26までにstagingでOAuth callback、refresh token暗号化保存、Calendar作成・同期、YouTube取得、要求時・定期同期を受入済みである。productionの別projectと公開審査は別工程とする。

## Critical・High remediation（2026-07-20）

監査で検出したCritical 2件、High 11件は [修正台帳](../reviews/critical-high-remediation.md) で追跡し、全件を修正済みにした。追加migrationで削除墓石、broadcast状態、SyncLeaseを導入し、CUID契約、Calendar reconciliation、既知video追跡、DB排他、SyncRun、暗号鍵fail-fast、clean生成、root `.env` 読込を実装した。Node 22.23.1で通常43件、MySQL 4件、E2E 1件、型/lint/build/worker、clean install、空/既存DB migrationを検証した。実資格情報が必要な受入手順と残存リスクは台帳に記録する。

## Reaudit remediation（2026-07-20）

[独立再監査](../reviews/critical-high-reaudit.md)で解消済みとされなかったCritical 1件・High 6件を[再監査修正台帳](../reviews/reaudit-remediation.md)で追跡し、全件を修正済みにした。追加migrationでSyncLease versionとYouTubeQuotaUsageを導入し、削除timeout/fencing、過去event作成防止、channel共有取得、quota延期、OAuth backoff、runId相関、低entropy鍵拒否を実装した。Node 22.23.1で通常69件、MySQL 6件、E2E 1件、型/lint/build/worker、clean install、既存/空DB migrationとschema diffを検証し、Phase 10を完了した。

## Final audit remediation（2026-07-22）

[最終独立監査](../reviews/final-critical-high-audit.md)の部分解消3件・新規High 4件を[最終修正台帳](../reviews/final-audit-remediation.md)で追跡する。channel取得snapshot lifecycleとphase別結果、追跡件数/期間上限とquota式、明示的Calendar作成policy、CSPRNG鍵運用、専用E2E port/health identityを追加migrationと回帰テストで実装した。最終的な品質ゲート・migration結果は台帳へ記録する。

Node 22.23.1のclean install後、cacheなしtypecheck/lint/test/build、通常96件、MySQL 7件、3000番別アプリ稼働下E2Eと連続実行、worker、既存/空DBの全5 migrationとschema差分なしを完了した。最終台帳の8項目を修正済みとし、コード上の既知Critical/Highは0件である。
