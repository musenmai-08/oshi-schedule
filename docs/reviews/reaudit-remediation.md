# Critical・High 再監査修正台帳

作成日: 2026-07-20  
基準: [Critical・High 修正結果の独立再監査](./critical-high-reaudit.md)

| ID          | 重要度   | 再監査判定   | 問題                                                                                   | 根本原因                                                | 修正対象                                                          | 回帰テスト                                                                | 状態     |
| ----------- | -------- | ------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------- | -------- |
| REAUDIT-001 | Critical | 部分解消     | アカウント削除のSupabase呼出しにtimeoutがなく、lease喪失後の古い処理が状態を書き戻せる | 外部呼出しの中断制御とlease fencingがない               | Auth/Calendar gateway、OshiService、Store、SyncLease、env         | timeout・再開・404・期限/更新・非owner・stale writer・通常API拒否         | 修正済み |
| REAUDIT-002 | High     | 部分解消     | 同期leaseがprocessの時計に依存し、期限切れ・crash・別keyの実DB検証が不足               | DB時刻を基準にした原子的lease契約とfencingがない        | Store、SyncService、SyncLease                                     | 期限前後・owner/version・別key・manual対scheduled・MySQL並行              | 修正済み |
| REAUDIT-003 | High     | 部分解消     | OAuth retryが50/100ms、jitterなし、Retry-After無視                                     | retry policyが設定・HTTP応答から独立していない          | GoogleCalendarGateway、env                                        | 429/5xx/timeout、delay、jitter、Retry-After、3回上限                      | 修正済み |
| REAUDIT-004 | High     | 部分解消     | 同期error logにrun IDがなく永続履歴と相関できない                                      | logger contextへrunIdを渡していない                     | SyncService、logging test                                         | failure logのrunId・subscriptionId・安全なerror code                      | 修正済み |
| REAUDIT-005 | High     | 部分解消     | key IDだけ変えた全ゼロ暗号鍵を本番で受理する                                           | 既知defaultを設定文字列全体でしか比較していない         | env、AesTokenCipher                                               | 全ゼロ/反復byte/sample拒否、tamper、IV、rotation                          | 修正済み |
| REAUDIT-006 | High     | 新規問題あり | 初回同期でmappingのない過去COMPLETED/UNAVAILABLEをCalendarへ新規作成する               | DB抽出後の新規作成可否が状態・mappingを考慮しない       | SyncService、Store query                                          | 過去mapped/unmapped、LIVE、UPCOMING、UNAVAILABLE、仮終了、反復            | 修正済み |
| REAUDIT-007 | High     | 新規問題あり | YouTube quota budget、原子的予約、channel単位共有取得がない                            | 外部quotaと取得処理をsubscriptionごとに直接実行している | Prisma schema/migration、Store、YouTube gateway、SyncService、env | unit計算、同時予約、日付境界、retry/page、延期、cache、共有channel、MySQL | 修正済み |

## 進行ルール

- 各項目は失敗する回帰テスト、根本修正、関連テスト、文書更新、全体検証の順に完了させる。
- 外部APIのbody、資格情報、quota keyはログ・履歴へ保存しない。
- DB変更は既存migrationを変更せず、追加migrationだけで適用する。
- 状態を「修正済み」にするのは、関連テストと最終品質ゲートが成功した後とする。

## 修正結果

- **REAUDIT-001**: Supabase Admin、Google Calendar、revoke、token endpointへ`AbortSignal` timeoutを追加した。削除leaseはDB時刻・owner token・単調増加versionでfencingし、各外部呼出しの前後で更新、step/FAILED/ローカル削除を同じowner/versionで条件付き更新する。削除lease設定は4外部callとOAuth最大待機を包含しない値を起動時に拒否する。
- **REAUDIT-002**: lease取得・takeover・renew・releaseをDBサーバー時刻と原子的SQLへ移し、stale owner/versionの更新を拒否した。subscription/channel別key、期限前後、manual/scheduled競合を検証した。
- **REAUDIT-003**: OAuth retryを最大3回、秒単位の指数backoff+jitter、`Retry-After`優先、設定可能な最大待機へ変更し、timeoutを`GOOGLE_TOKEN_TIMEOUT`として別分類した。
- **REAUDIT-004**: 同期失敗logへ`runId`、`subscriptionId`、安全なerror codeを追加し、永続`SyncRun`と相関可能にした。
- **REAUDIT-005**: real/productionではkey IDに依存せず、全ゼロ・単一byte反復を含む32-byte低entropy鍵を起動時に拒否する。AES-GCMのランダムIV、tamper検知、複数key rotationも回帰検証した。
- **REAUDIT-006**: mappingなしの新規Calendar eventは`UPCOMING`/`LIVE`だけに限定した。mapping済みの過去状態は更新でき、mappingなし`COMPLETED`/`UNAVAILABLE`は反復同期でも作成しない。
- **REAUDIT-007**: `GENERAL`/`SEARCH`別の日次quota行、予約中/使用済みunit、原子的条件付き予約を導入した。全attempt/pageを予約後にのみ実行し、失敗requestも消費へ移す。枯渇時は外部callせず、DB cacheで同期して`SKIPPED`/HTTP 202 `DEFERRED`と次回時刻を返す。同一channelはchannel leaseとfreshness再確認により共有取得する。

既知の未修正Critical/Highは **0件**。実資格情報、複数host、集約監視、Cloud Console実消費量の確認はstaging/運用受入であり、コード上の未修正項目ではない。

## YouTube取得方式とquota設計

チャンネルの予定・ライブ・既知動画を網羅する必要があるため、`search.list`で予定/LIVEを探索し、既知IDを`videos.list`で追跡する方式を維持した。uploads playlistはアップロード済み動画の列挙には使えるが、将来のscheduled stream探索を同じ契約で保証しないため全面置換していない。通常のscheduled run上限は1 channelあたり`SEARCH=1`、`GENERAL=2`、24時間72回では`SEARCH=72`、`GENERAL=144`。最大3attemptを仮定した理論上限はそれぞれ216/432だが、設定した予算`SEARCH=80`、`GENERAL=8000`とscheduled reserve 72/432により、通常同期を優先しつつ上限前に延期する。quota日は`America/Los_Angeles`の暦日で計算しDST境界も検証した。

## 変更範囲

- API/application: `account-deletion`、`oshi-service`、`sync-service`、model/error/HTTP契約、container。
- infrastructure: auth、Google Calendar/OAuth、YouTube gateway/quota、Prisma/Memory store、env、AES-GCM。
- schema/migration: `prisma/schema.prisma`、`20260720150000_reaudit_remediation`、`20260720160000_align_quota_updated_at`。
- shared/docs/config: shared status型、`.env.example`、README、API/OpenAPI、認証・同期・DB・security・test・実装計画・監査台帳。
- tests: account deletion 6、sync 13、Google gateway 10、YouTube gateway 9、auth 3、lease 3、env 6、AES 4、memory store 1、API等既存14、shared 3、MySQL 6、E2E 1。

## 最終検証

Node.js 22.23.1、pnpm 9.15.9、Docker MySQL 8.4を使用した。

| 検証                                                              | 結果                                                                 |
| ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| node_modules 6箇所削除 → `CI=true pnpm install --frozen-lockfile` | 成功、lockfile差分なし、Prisma生成成功                               |
| `turbo typecheck --force`                                         | 6/6成功、cache 0                                                     |
| `turbo lint --force`                                              | 6/6成功、cache 0                                                     |
| `TURBO_FORCE=true pnpm test`                                      | API 66 + shared 3 = 69成功、DB 6はURL未指定のため意図的skip、cache 0 |
| `turbo build --force`                                             | 4/4成功、cache 0                                                     |
| `pnpm test:e2e`                                                   | Chromium 1成功                                                       |
| `APP_MODE=fake ... pnpm sync:scheduled`                           | 成功、targets 0 / failed 0                                           |
| Docker MySQL integration                                          | 6/6成功（期限切れtakeover、30並列quota予約、step fencingを含む）     |
| 既存DB `prisma migrate deploy/status/diff`                        | migration 4件適用、up-to-date、schema差分なし                        |
| 完全な空DB `prisma migrate deploy/diff`                           | migration 4件を一括適用、schema差分なし。検証用DBは完了後に削除      |

自動テストの成功件数は通常69 + MySQL 6 + E2E 1 = **76件**。build時に既存のNext.js ESLint plugin未検出warningは出るが、lint/typecheck/buildは成功しており今回のCritical/Highとは無関係である。

## 残存リスクとstaging受入

- 実Supabase/Google/YouTube資格情報がないため、OAuth callback/refresh/revoke、削除済みuserへのSupabase応答、実quota消費は未接続。stagingでtimeout、429/5xx、`Retry-After`、再実行を確認する。
- 複数hostでのprocess kill、lease takeover、channel共有取得、集約ログ上の`runId`相関、Secret Managerでのkey rotationをstagingで確認する。
- quota予約後にprocessが停止した場合、予約unitはそのPacific日中は保守的に使用済み相当として残る。上限超過より過少利用を選ぶ安全側の設計であり、日次resetで解消する。
- 実projectのquota割当はCloud Consoleを正とし、`YOUTUBE_*_DAILY_BUDGET`とreserveを配備先の割当に合わせて確定する。

コード変更のgit commitは作成していない。
