# Critical・High 修正結果の独立再監査

再監査日: 2026-07-20  
対象ブランチ: `audit/verify-critical-high`  
対象HEAD: `c3e558f fix: resolve critical and high audit findings`  
比較基点: `867c6b0 chore: checkpoint initial MVP`

## 1. エグゼクティブサマリー

修正台帳を正とはせず、元監査、要件・設計、差分、現行コード、回帰テスト、実MySQL、clean installを独立に照合した。

- Critical 2件: **解消済み1件、部分解消1件**
- High 11件: **解消済み5件、部分解消4件、新規問題あり2件**
- 未解消: 0件、検証不能: 0件（コードレベルの判定。実サービス接続試験は別途stagingブロッカー）
- 新規Critical: 0件、新規High: 2件
- 品質ゲート、clean install、既存DB・空DBmigration、MySQL integration、E2E、Fake worker smokeはすべて成功した。
- ただし、初回同期で過去の終了済み配信をCalendarへ新規作成する問題と、現行のYouTube検索が現行の既定quotaを容易に使い切る問題がある。加えてアカウント削除の外部呼び出しtimeout欠落など、Critical/Highの部分解消が5件残る。

したがって、**現時点では本番公開不可**と判定する。

## 2. 再監査対象

起点は `docs/reviews/implementation-audit.md` と `docs/reviews/critical-high-remediation.md`。併せて `docs/requirements/`、`docs/architecture/`、`docs/database/`、`docs/api/`、`docs/security/`、`docs/testing/`、`docs/development/`、`apps/web/`、`apps/api/`、`apps/worker/`、`packages/shared/`、Prisma schema/migrations、root scripts、lockfile、Turbo設定、READMEを確認した。

Git上の修正範囲は `867c6b0..c3e558f` の1コミットで、`git show --stat` は46 files changed、2524 insertions、266 deletionsだった。監査開始時のworktreeはcleanだった。

## 3. 検証環境

| 項目 | 値 |
| --- | --- |
| OS/実行環境 | macOS、リポジトリ `/Users/tezuka/Desktop/products/oshi-schedule` |
| Node.js | v22.23.1（nvmで明示選択） |
| pnpm | 9.15.9 |
| DB | Docker Compose MySQL 8.4 |
| Browser | Playwright Chromium |
| 実サービス資格情報 | 未使用。Supabase、Google Calendar/OAuth、YouTubeはFake・mock・静的監査まで |

## 4. 実行したコマンドと結果

| コマンド | 結果 |
| --- | --- |
| `git status --short` | 開始時出力なし（clean） |
| `git log --oneline --decorate -5` | HEAD `c3e558f`、基点 `867c6b0` を確認 |
| `git show --stat --oneline HEAD` / `git diff HEAD^..HEAD` | 修正コミット全体を確認 |
| `source ~/.nvm/nvm.sh && nvm use 22.23.1` | Node v22.23.1を選択 |
| `node -v` / `pnpm -v` | v22.23.1 / 9.15.9 |
| `docker compose up -d mysql` | MySQL起動済みを確認 |
| 対象6箇所の `node_modules` 削除後、`CI=true pnpm install --frozen-lockfile` | 成功。434 packages、postinstallでPrisma Client生成 |
| `pnpm typecheck` | 成功、6/6 tasks |
| `pnpm lint` | 成功、6/6 tasks |
| `pnpm test` | 成功、43件。MySQL専用4件は通常runではskip |
| `pnpm build` | 成功、4/4 build tasks。Next.js ESLint plugin警告のみ |
| `pnpm test:e2e` | 成功、Chromium 1件 |
| `APP_MODE=fake ... pnpm sync:scheduled` | 成功、targets=0、failed=0 |
| `pnpm db:generate` | 成功 |
| 既存DB `prisma migrate status` | 2 migrations適用済み、up to date |
| 既存DB `prisma migrate diff ... --exit-code` | 差分なし |
| 専用空DBへの `prisma migrate deploy` | 2 migrationsを先頭から適用成功 |
| 専用空DBのschema diff | 差分なし |
| 専用DBでMySQL integration | 4/4成功 |
| 環境検証用のread-only診断 | `v2:` 全ゼロ鍵をreal modeが受理すること、初回同期が過去配信を作成対象にすることを再現 |

空DBへの最初のmigration実行と、2本のread-only診断はsandboxのプロセス/IPC制限で一度失敗したが、同一コマンドを許可済みの外部実行で再実行して成功した。これはアプリケーションの失敗として数えていない。

## 5. Critical 2件の判定

| ID | 元の重要度 | 判定 | 根拠 | テスト | 残存リスク |
| -- | ----- | -- | -- | --- | ----- |
| AUDIT-001 | Critical | **部分解消** | subject基準の永続tombstone、段階再開、通常APIの410、User物理削除後の墓石、DB lease、外部呼出しのtransaction外実行は実装済み。一方 `SupabaseAuthAdmin.deleteUser` にtimeoutがなく、15分leaseを越えて停止できる | MemoryStoreで段階失敗・再開・二重実行・旧JWT・他User、MySQLで墓石とleaseを検証 | Supabase fetchが無期限に待つと削除が `DELETING` のまま残り、lease失効後に同一stepが並行実行され得る。実MySQL上の削除use case同時実行も未検証 |
| AUDIT-002 | Critical | **解消済み** | Prisma、shared schema、route、OpenAPI、FakeがCUID契約で統一され、WebにUUID前提なし | 実MySQL生成CUIDでpause/resume/sync/delete、400/404/他User所有権を検証 | 実質的なCritical残存なし |

### AUDIT-001 詳細

`apps/api/src/application/oshi-service.ts` は削除開始前にtombstoneを作り、各stepの完了状態を永続化し、再実行時に済んだstepを飛ばす。`requireActiveUser` はtombstoneを先に照会するため旧JWTからUserを再生成せず、暗黙作成はonboardingへ限定されている。Prismaではtombstoneの `supabaseUserId` が一意で、User FKはnullableかつ `SetNull` である。エラー保存も定数error codeに限定されている。

しかし `apps/api/src/infrastructure/auth/auth.ts:42-53` のSupabase Admin DELETEには `AbortSignal.timeout` がない。削除leaseは15分で外部step前にだけ更新されるため、fetchが15分を越えると別要求が期限切れleaseを取得し、同じAuth削除stepが並行し得る。404の冪等化は正しいが、timeout/network例外の安全な分類もこのadapter単体では行っていない。このため根本的な再開・直列化保証は完成していない。

### AUDIT-002 詳細

`packages/shared` のCUID schemaをrouteが使用し、OpenAPIも同形式、MemoryStoreもCUIDを生成する。MySQL integrationは実DBのIDを使って主要4操作、形式不正400、存在しない正形式404、他Userの所有権境界を通過しており、修正前のUUID/CUID不一致を直接防ぐ。

## 6. High 11件の判定

| ID | 元の重要度 | 判定 | 根拠 | テスト | 残存リスク |
| -- | ----- | -- | -- | --- | ----- |
| AUDIT-003 Calendar削除・復旧 | High | **新規問題あり** | hash一致時も存在確認し、event 404とCalendar 404/410、決定的ID、mapping更新を実装。ただし初回同期では履歴を無制限に列挙する | event 404、Calendar 404、mapping差替、重複なしをmockで確認。410と「過去を復元しない」は直接テストなし | 新規High R-H01: 新規登録・Calendar再構築経路で過去のCOMPLETED配信を作成できる |
| AUDIT-004 配信状態追跡 | High | **新規問題あり** | 既知video IDの詳細再取得、状態・実終了・UNAVAILABLEを実装。通常動画をupcoming検索から除外 | 時系列fixtureでUPCOMING/LIVE/COMPLETED/UNAVAILABLE等を確認 | 新規High R-H02: `search.list` の最大10ページをチャンネルごとに定期実行し、現行既定quotaを容易に枯渇。毎観測時の `sourceUpdatedAt` 更新もCalendar存在確認を増幅 |
| AUDIT-005 プレミア公開判定 | High | **解消済み** | duration heuristicを廃止し、第三者Data APIで確定不能な種別をUNKNOWNとしてDB/API/Calendarで扱う | duration非依存、live、通常動画除外を確認 | UNKNOWNが増えることは意図した安全側仕様。Webは種別へ依存しない |
| AUDIT-006 分散ロック | High | **部分解消** | API/worker共通PrismaStoreの `SyncLease`、atomic create/期限切れupdate、owner付きrenew/releaseを実装 | MemoryStore同時同期と実MySQL leaseを確認 | DB時刻でなく各processのアプリ時刻を比較するためclock skewで早期奪取/回収遅延があり得る。期限切れ回収、異なるkey、manual対scheduled、crashを実DB end-to-endで未検証 |
| AUDIT-007 Calendar重複防止 | High | **解消済み** | user ID + video IDのSHA-256から安定IDを生成し、GoogleのID文字・長さ制約内。409はPATCHへ収束 | mapping保存失敗後、409→PATCH、再実行1件を確認 | 暗号学的衝突は現実的でない。外部実サービス確認はstaging事項 |
| AUDIT-008 OAuthエラー処理 | High | **部分解消** | invalid_grantのみreauth、429/5xx/network/timeoutはretryable、最大3回、reauth user除外、secret非記録 | 主なstatus分類、3回上限、再連携をmockで確認 | 待機が50ms/100msでjitterなし、`Retry-After` 無視。公式推奨の秒単位指数backoffに比べ短く、quota/障害時に集中再試行する |
| AUDIT-009 同期履歴 | High | **部分解消** | SyncRun/Targetの開始・成功・部分失敗・全失敗、24時間stale回収、90日保持を実装 | MemoryStore中心に各状態とretentionを確認 | error logに `runId` がなく、永続履歴とログを相関できない。stale/retentionのMySQL検証なし |
| AUDIT-010 3チャンネル上限 | High | **解消済み** | User行を `FOR UPDATE` し、serializable transaction内でcount+create。一時停止もcount対象 | 実MySQLで本当に並行登録し、成功1/上限エラー1、合計3件を確認 | Prisma P2034の限定再試行はないが、同一User行lockの実経路は成立。将来DB/driver変更時は監視が必要 |
| AUDIT-011 暗号鍵 | High | **部分解消** | 32-byte、重複ID、既知の正確なdefault文字列は拒否。AES-256-GCM、ランダム12-byte IV、auth tag、key IDを暗号文に保持 | default/長さ/重複/複数鍵を確認 | `v2:` に変更した同じ全ゼロ32-byte鍵はreal/productionで受理することを再現。既知・低entropy鍵の拒否という根本要件を満たさない。IV非再利用・tamper/rotationの明示テストも不足 |
| AUDIT-012 clean install | High | **解消済み** | postinstall、pretypecheck、prebuildとTurbo依存がPrisma生成を保証 | 実際に全6 `node_modules` を削除しfrozen installから品質ゲート成功 | postinstall自体の問題は再現せず |
| AUDIT-013 root `.env` | High | **解消済み** | `import.meta.url` からroot `.env` の絶対位置を解決し、API/workerが同じloaderを使用。real/production必須値をfail-fast | path契約とenv test、clean buildを確認 | 実資格情報による起動はstaging事項。今回の再監査では唯一許可されたreport以外を作らないため一時 `.env` smokeは再実施せず、既存回帰テストと静的経路を確認 |

## 7. 根拠となるファイルとコード

主要な根拠を以下にまとめる（行番号は対象HEAD時点）。

| 論点 | 根拠 |
| --- | --- |
| 削除tombstone・段階再開・lease | `apps/api/src/application/oshi-service.ts:116-199`、`prisma/schema.prisma`、`prisma/migrations/20260720090000_critical_high_remediation/migration.sql` |
| Supabase削除timeout欠落 | `apps/api/src/infrastructure/auth/auth.ts:37-53` |
| CUID契約 | `packages/shared/src/schemas.ts`、`apps/api/src/presentation/routes.ts`、`docs/api/openapi.yaml`、`apps/api/src/prisma-api.integration.test.ts` |
| 初回同期の無制限履歴 | `apps/api/src/infrastructure/database/prisma-store.ts:371-382`、`apps/api/src/application/sync-service.ts:110-141` |
| Calendar存在確認・決定的ID | `apps/api/src/application/sync-service.ts:11-12,119-140`、`apps/api/src/infrastructure/google-calendar/google-calendar-gateway.ts` |
| YouTubeページング・追跡 | `apps/api/src/infrastructure/youtube/youtube-data-gateway.ts:130-170`、`apps/api/src/infrastructure/database/prisma-store.ts:311-357` |
| DB lease | `apps/api/src/infrastructure/database/prisma-store.ts:431-453`、`apps/api/src/application/sync-service.ts:23-31,53-73,104,116,190` |
| OAuth分類・retry | `apps/api/src/infrastructure/google-calendar/google-calendar-gateway.ts:17-66` |
| 同期履歴・ログ相関 | `apps/api/src/application/sync-service.ts:55-72,148-187,194-215`、`apps/api/src/infrastructure/database/prisma-store.ts:455-535` |
| 3件上限 | `apps/api/src/infrastructure/database/prisma-store.ts:257-275` |
| 暗号鍵 | `apps/api/src/infrastructure/env.ts:8,26-43`、`apps/api/src/infrastructure/encryption/aes-token-cipher.ts` |
| clean install / env | `package.json`、`turbo.json`、`prisma.config.ts`、`apps/api/src/infrastructure/env.ts:5-6` |

外部仕様との照合では、Google Calendar event IDは小文字 `a-v` と数字 `0-9`、長さ5–1024という制約であり、現行の `oshi` + SHA-256 hexは適合する。一方、YouTube Data APIの現行ドキュメントでは `search.list` は別枠の既定100 calls/dayで、追加ページも1 callを消費する。OAuth/Calendar quotaの公式ガイドはtruncated exponential backoffとjitterを推奨する。

- [Google Calendar events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)
- [YouTube quota cost calculator](https://developers.google.com/youtube/v3/determine_quota_cost)
- [YouTube search.list](https://developers.google.com/youtube/v3/docs/search/list)
- [Google OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google Calendar quota and backoff](https://developers.google.com/workspace/calendar/api/guides/quota)
- [Supabase user deletion and JWT lifetime](https://supabase.com/docs/guides/auth/managing-user-data)

## 8. 回帰テストの妥当性

通常43件、MySQL専用4件、E2E 1件の合計48件はすべて成功した。単なる件数ではなく内容を確認した。

良好な点:

- MySQL integrationは実CUID、所有権、並列3件上限、User削除後tombstone、DB leaseを実制約上で確認する。並列登録はpromiseを同時投入しており形式的な逐次テストではない。
- アカウント削除は各段階の失敗、再開、反復、旧JWT、他User境界をfault injectionで確認する。
- Calendarはevent 404、Calendar 404、409、mapping保存失敗後の収束を確認する。
- YouTubeは時刻を固定し、状態遷移、実終了時刻、欠落、通常動画除外をfixtureで確認する。
- E2Eは表示確認だけでなく、登録、一時停止、再開、同期、解除のユーザーフローを操作する。

不足・弱い点:

- Supabase Admin adapterのtimeout/network/404と、実MySQL上のアカウント削除use case同時実行がない。
- 「新規購読者へ過去COMPLETEDを作らない」テストがなく、実際に診断で破綻を再現した。
- Calendar 410の個別fixture、Calendar再作成後の未来だけの復元、登録解除時の未来CANCELLED、他User event非削除を組み合わせたend-to-endがない。
- YouTubeのページ数・チャンネル数に対する日次quota budget、同一チャンネルを購読する複数Userからのfetch fan-outを検査しない。
- DB leaseは取得/owner更新を検査するが、期限切れ奪取、別key非干渉、manual対scheduled、worker crashを実DBで検査しない。
- OAuth retry回数は検査するが、秒単位backoff、jitter、`Retry-After` はassertしない。
- stale RUNNINGと90日retentionはMemoryStore中心で、MySQLの境界時刻・必要履歴保持を検査しない。logにrun IDがあることもassertしない。
- AES-GCMのIV一意性、tamper時のtag検証失敗、旧鍵復号から新鍵へのrotation、key IDだけ変えた全ゼロ鍵拒否がない。
- Web/workerのVitestは0件を許容する。E2Eとworker smokeで一部補完するが、削除・再連携・異常系UIは未網羅。

## 9. clean install検証

事前に `pwd` と `git status --short` を確認し、リポジトリ内で検出した次の6ディレクトリだけを削除した。

- root `node_modules`
- `apps/api/node_modules`
- `apps/web/node_modules`
- `apps/worker/node_modules`
- `packages/shared/node_modules`
- `packages/eslint-config/node_modules`

その後 `CI=true pnpm install --frozen-lockfile` が成功し、postinstallでPrisma Clientが生成された。手動 `db:generate` を先に実行せず、typecheck、lint、test、buildがすべて成功した。lockfile変更はない。AUDIT-012は再現性を含めて解消済みと判断する。

## 10. migration検証

既存開発DBでは2 migrationsが適用済みで `migrate status` はup to date、schema diffは0だった。

通常DBと分離した検証専用DB `oshi_schedule_reaudit_20260720` を作成し、空の状態から2 migrationsを順に適用した。適用後のPrisma schema diffは0で、同DBに対するMySQL integration 4件も成功した。検証後、この専用DBだけをdropした。既存DBとmigrationファイルは変更していない。

## 11. 新規に発見した問題

### R-H01 初回同期が過去の終了済み配信をCalendarへ新規作成する

- 重要度: **High**
- 対象ファイル: `apps/api/src/infrastructure/database/prisma-store.ts:371-382`、`apps/api/src/application/sync-service.ts:110-141`
- 対象コード: `since` がnullの場合、`listBroadcastsForSync` のwhereに時刻条件が一切付かない。同期loopはmappingのないCOMPLETEDもskipしない。
- 発生条件: あるチャンネルに過去の配信履歴が保存された後、別Userが新規購読して初回同期する、または `lastCalendarSyncAt` がnullの購読を同期する。
- 影響: 要件の「今後30日」と異なり、保存済みの過去配信が大量にCalendarへ投入される。Calendar再作成時の復元範囲も過去へ広がり、API呼数と利用者データを不必要に増やす。
- 再現結果: MemoryStore/SyncServiceへ1年以上前のCOMPLETED配信を置いたread-only診断で `historical-events-created=1` を確認した。
- 修正方針: mappingなしの新規作成はlookahead内の未来だけに限定する。過去項目は既存mappingがあり状態変更を反映する場合だけ更新する。初回と増分のquery契約を分離する。
- 必要なテスト: 過去COMPLETEDを持つ共有チャンネルへの新規購読、Calendar再作成、未来/過去混在、過去mappingあり/なしを固定Clockで検証し、過去の新規eventが0件であることをassertする。

### R-H02 YouTube upcoming検索が現行の既定quotaを容易に枯渇させる

- 重要度: **High**
- 対象ファイル: `apps/api/src/infrastructure/youtube/youtube-data-gateway.ts:130-149`、`apps/api/src/application/sync-service.ts:81-103,194-210`、`apps/api/src/infrastructure/database/prisma-store.ts:311-330`
- 対象コード: 1チャンネル取得で `search.list` を最大10ページ実行し、scheduled workerは購読単位で同期する。チャンネルfreshnessは通常の直列run内では重複を抑えるが、別process/別subscription leaseから同一チャンネルを同時取得するchannel-level leaseはない。またupsertは実質差分がなくても `sourceUpdatedAt=observedAt` にする。
- 発生条件: hourly workerで5チャンネルを各1ページ取得すると120 calls/day。1チャンネルが10ページなら10時間で100 callsへ達する。同一チャンネルへの並行manual/worker実行はさらに重複し得る。
- 影響: 現行の既定100 calls/dayの `search.list` 別枠quotaを枯渇し、予定取得が日中に停止する。再試行・Calendar存在確認のfan-outも増える。
- 修正方針: channel単位のDB leaseと取得jobを導入し、subscription同期とYouTube取得を分離する。日次quota budget、ページ上限/停止条件、quota使用量の監視と劣化動作を定義し、必要ならquota増枠を申請する。変更があるときだけ `sourceUpdatedAt` を進める。
- 必要なテスト: 24時間・最大3購読/User・共有チャンネル・複数workerをモデル化したcall budget、最大ページ、同一channel並行、quota超過時の部分失敗と翌日復帰、無変更時にCalendar GETを増やさないことを検証する。

### High未満だが追跡すべき事項

- 登録解除の `listFutureBroadcasts` はCANCELLEDを除外するため、未来の中止event/mappingが残る。要件の「未来イベントだけを削除」と揃える必要がある。
- tombstoneは旧JWT拒否に必要だが保持期限・匿名化方針がなく、永続的に増える。最大JWT/session寿命と監査要件を踏まえたretentionを定義する。
- serializable transactionのP2034 retryがない。現行MySQL並列テストは成功したが、高競合時の限定retryと計測を検討する。
- lease期限判定がDB時刻でなくprocessのClockに依存する。複数hostのclock skew許容値を定義するかDB時刻へ寄せる。

## 12. 実資格情報が必要で検証不能な項目

これらは個別AUDIT項目全体を「検証不能」にするものではないが、本番公開前のstagingブロッカーである。

1. Supabase実JWTの削除後寿命、Admin DELETEの404/5xx/timeout、同一Googleアカウントでの再登録とsubject変化。
2. Google Calendar実環境でのCalendar/event手動削除、404/410、決定的ID 409、mapping保存失敗後の重複なし、他User/過去event保持。
3. Google OAuth consent/revokeによるinvalid_grant、429/5xx障害注入、`Retry-After`、再連携後のscheduled復帰。
4. YouTube実チャンネルのUPCOMING→LIVE→COMPLETED、非公開/削除、UNKNOWN、実quota消費量。
5. 複数API/worker replicaでの長時間同期、lease延長、process kill後の期限切れ回収。

## 13. 本番公開可否

**本番公開不可。** Criticalの部分解消1件、Highの部分解消4件、新規High 2件が残る。特に、削除処理のtimeout/lease保証、過去Calendar eventの誤作成、YouTube quota枯渇は、公開可否基準に直接抵触する。品質ゲートとmigrationが成功したことだけでは相殺できない。

## 14. 次に対応すべき項目

優先順は次のとおり。

1. **AUDIT-001を完了する**: Supabase Admin呼び出しへ明示timeoutと安全なnetwork分類を追加し、leaseが外部callより十分長い/更新可能な設計へする。実MySQLで段階失敗・同時削除・期限切れ再開を結合テストする。
2. **R-H01を修正する**: mappingなしの過去配信をCalendar新規作成対象から除外し、新規購読とCalendar再作成の未来のみ復元テストを追加する。
3. **R-H02を修正する**: channel単位の取得排他、quota budget/監視、ページ制御、真の差分更新を実装し、24時間call-budgetテストを追加する。
4. `TOKEN_ENCRYPTION_KEYS` はkey IDでなく鍵bytesを検査し、既知default/全ゼロ/低entropy設定をreal/productionでfail-fastする。tamper、IV、rotationテストを追加する。
5. OAuthを秒単位+jitter+`Retry-After` 対応へし、Sync error logへ `runId` を含める。DB lease/stale/retentionの実MySQL異常系を拡張する。

本再監査で変更したのはこのレポートだけであり、アプリケーションコード、設定、既存テスト、既存ドキュメントは変更していない。
