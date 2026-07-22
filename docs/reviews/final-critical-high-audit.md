# Critical・High 最終独立監査

監査日: 2026-07-22  
監査対象HEAD: `838e170 fix: resolve critical and high reaudit findings`  
監査方針: 修正台帳の自己申告を判定根拠にせず、現行コード、commit差分、実MySQL、回帰テスト、独立再現、公式仕様から再判定した。

## 1. エグゼクティブサマリー

REAUDIT-001〜007の最終判定は、**解消済み4件、部分解消3件、未解消0件**である。新規Criticalは0件、新たに確認したHigh相当の問題は4件である。

- REAUDIT-001（削除timeout/fencing）、002（DB時刻lease）、003（OAuth retry）、004（runId相関）は解消済みと判定した。
- REAUDIT-005は、8種類のbyteを4回繰り返すだけの32-byte鍵がproduction/realで受理され、低entropy拒否が容易に回避できるため部分解消である。
- REAUDIT-006は、mappingなしでも開始・終了が過去の`UPCOMING`をCalendarへ新規作成することを再現したため部分解消である。
- REAUDIT-007は、別workerがchannel leaseを保持していると後続workerが古いcacheで`SUCCESS`になり、そのユーザーだけ新規eventを取りこぼす。また、既知動画集合が無制限なので「GENERAL 144が最大」という計算とreserve 432の保証がコードと一致しない。よって部分解消である。
- typecheck、lint、通常69件、build、worker、MySQL 6件、既存/空DB migrationは成功した。標準`pnpm test:e2e`は別プロジェクトの3000番サーバーを誤再利用して失敗し、3100/4100番へ隔離した同一シナリオは1件成功した。

Critical・Highが部分解消のため、**現時点で本番公開可能とは判定しない**。

## 2. 監査対象

- 監査資料: `implementation-audit.md`、`critical-high-remediation.md`、`critical-high-reaudit.md`、`reaudit-remediation.md`。
- 設計: `docs/requirements`、`architecture`、`database`、`api`、`security`、`testing`、`development`。
- 実装: `apps/web`、`apps/api`、`apps/worker`、`packages/shared`。
- DB: `prisma/schema.prisma`、全4 migration。
- 構成: README、`.env.example`、`package.json`、`pnpm-lock.yaml`、`turbo.json`、Playwright設定。
- Git: `git status --short`は監査開始時clean。直近は`838e170`、`bd56632`、`c3e558f`、`867c6b0`。`HEAD^..HEAD`は40ファイル、1933 additions / 365 deletions。

## 3. 検証環境

- macOS / Asia/Tokyo
- Node.js `v22.23.1`
- pnpm `9.15.9`
- Docker MySQL `8.4`、container healthy、DB timezone UTC
- Prisma / Client `6.19.3`
- Playwright `1.61.1` / Chromium

## 4. 実行したコマンドと結果

| 検証                                                                                | 結果                                                                                                    |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `git status --short`                                                                | 監査開始時clean                                                                                         |
| `git log --oneline --decorate -5` / `git show --stat HEAD` / `git diff HEAD^..HEAD` | 成功、修正commitと全差分を確認                                                                          |
| `docker compose up -d mysql` / `docker compose ps`                                  | 成功、MySQL healthy                                                                                     |
| 6箇所の`node_modules`削除                                                           | 対象を列挙・絶対path確認後に成功                                                                        |
| `CI=true pnpm install --frozen-lockfile`                                            | Node 22.23.1で成功、lockfile差分なし、434 packages、Prisma生成成功                                      |
| `pnpm exec turbo typecheck --force`                                                 | 6/6成功、cache 0                                                                                        |
| `pnpm exec turbo lint --force`                                                      | 6/6成功、cache 0                                                                                        |
| `TURBO_FORCE=true pnpm test`                                                        | API 66 + shared 3 = 69成功、MySQL 6件はURL未指定のためskip、cache 0                                     |
| `pnpm exec turbo build --force`                                                     | 4/4成功、cache 0。既存のNext.js ESLint plugin warningあり                                               |
| `pnpm sync:scheduled` (`APP_MODE=fake`)                                             | 成功、targets 0 / failed 0                                                                              |
| `pnpm test:e2e`                                                                     | **失敗**。別projectのDocker server（3000番）を`reuseExistingServer`で誤再利用し、別のログイン画面へ接続 |
| 別port 3100/4100・`reuseExistingServer=false`で同一E2E                              | Chromium 1/1成功。一時設定は実行後削除                                                                  |
| MySQL integration                                                                   | 6/6成功                                                                                                 |
| 既存DB migrate deploy/status/diff                                                   | migration 4件、up-to-date、差分なし                                                                     |
| 専用空DB migrate deploy/status/diff                                                 | 4件を初回から適用、up-to-date、差分なし。完了後DB削除                                                   |
| Supabase abort独立probe                                                             | Node 22で`aborted=true`、`AUTH_DELETE_TIMEOUT`                                                          |
| 低entropy鍵独立probe                                                                | `[0..7]`反復32-byte鍵がproduction/realで`accepted=true`                                                 |
| 過去UPCOMING独立probe                                                               | `status=SUCCESS`かつCalendar event 1件作成を再現                                                        |
| 共有channel並行probe                                                                | YouTube call 1回、後続userは`SUCCESS`だがevent 0件、完了後も全体で1user分だけを再現                     |

## 5. REAUDIT-001〜007の判定

| ID          | 元の重要度 | 最終判定     | 根拠ファイル                                                                          | 回帰テスト                                                                             | 残存リスク                                                                                                                  |
| ----------- | ---------- | ------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| REAUDIT-001 | Critical   | **解消済み** | `auth.ts`、`google-calendar-gateway.ts`、`oshi-service.ts`、`prisma-store.ts`、schema | auth 3、account deletion 6、lease 3、MySQL deletion fencing                            | 実Supabaseの応答はstaging。既存testはsignal存在までだが、独立probeで実abortを確認                                           |
| REAUDIT-002 | High       | **解消済み** | `prisma-store.ts:479-518`、SyncLease version migration                                | Memory lease境界、MySQL同時取得/takeover/stale owner                                   | 複数host process killはstaging。DB時刻SQLとfencing自体は成立                                                                |
| REAUDIT-003 | High       | **解消済み** | `google-calendar-gateway.ts:20-87`、env                                               | gateway 10件: invalid_grant、invalid_client、429/5xx/network/timeout、Retry-After、3回 | 実GoogleのHTTP-date `Retry-After`はstaging                                                                                  |
| REAUDIT-004 | High       | **解消済み** | `sync-service.ts:57-58,99-102,141-148,214-216`、SyncRun/Target                        | failure logger spy、scheduled target履歴、quota logger context                         | Calendar gateway自体はrunId contextを受けないが、例外は同一runIdのUseCase error logへ集約。gateway-level spanは運用改善事項 |
| REAUDIT-005 | High       | **部分解消** | `env.ts:96-101`、`aes-token-cipher.ts`                                                | env 6、AES 4。全ゼロ/単一byte、IV、tamper、rotationは成功                              | **High F-01**: unique byte数8だけで受理され、周期的な低entropy鍵を拒否できない                                              |
| REAUDIT-006 | High       | **部分解消** | `sync-service.ts:169-188`                                                             | mapped/unmapped COMPLETED/UNAVAILABLE、LIVE、future UPCOMING、反復                     | **High F-02**: mappingなしの過去`UPCOMING`を新規作成する。該当fixtureがない                                                 |
| REAUDIT-007 | High       | **部分解消** | quota cost/gateway、`prisma-store.ts:388-399,479-556`、`sync-service.ts:80-156`       | quota 9、sync 13、MySQL30並列予約                                                      | **High F-03/F-04**: channel lease followerの同期欠落、追跡ID無制限による最大値・reserve計算不一致                           |

### REAUDIT-001: アカウント削除

Google Calendar request、OAuth revoke/token、Supabase Admin DELETEはすべて`AbortSignal.timeout`を実fetchへ渡す。`Promise.race`だけの実装はない。timeoutは固定AppError codeとして墓石へ保存され、body/tokenは保存しない。Supabase 404、Calendar 404/410、revoke 400は冪等成功である。

削除要求は`supabaseUserId`で一意、User FK削除後も墓石を保持し、通常API/onboardingを拒否する。leaseはMySQLの`UTC_TIMESTAMP(3)`、owner、version、expiresAtで取得・更新し、step/FAILED/User削除を有効なowner/versionと同一transactionでfenceする。外部通信中にDB transactionは保持しない。timeout後の再開、後継取得、遅延した古いwriterの拒否も確認した。

### REAUDIT-002: DB時刻lease

PrismaStoreは呼出し元の`now`を期限判定に使わず、atomic UPDATE / INSERT IGNOREとDB時刻を使用する。renewもowner/version/未期限切れ条件を持つ。MySQLで同時取得1件、強制期限切れ後のversion増加、stale renew/release拒否を確認した。

### REAUDIT-003: OAuth retry/backoff

`invalid_grant`だけを再認証へ移し、`invalid_client`等の恒久4xxは再試行しない。429/5xx/network/timeoutだけ最大3 attempt、各attemptに新しいtimeout、指数backoff+jitter、`Retry-After`、最大待機を適用する。sleep/randomは注入可能でtestは実時間待機しない。token/response全文はログ出力しない。

### REAUDIT-004: runIdログ相関

manualはSyncRun作成時のID、scheduledは親runIdを全subscriptionへ渡す。DBのSyncRun/SyncTargetResult、SyncService error log、quota延期log、YouTube quota logは同じrunIdを使う。token/emailは相関IDに使わない。Calendar gatewayへcontext自体は渡らないが、Calendar errorはSyncService境界でrunId付きの構造化error logになるため、元指摘の「永続履歴とerror logを相関できない」は解消した。

### REAUDIT-005: 暗号鍵

AES-256-GCM、32-byte、96-bit random IV、authentication tag、ciphertext内key ID、複数key復号/先頭key暗号化は成立する。一方、production検証は`new Set(key).size >= 8`だけである。独立probeでbyte列`00 01 ... 07`を4回繰り返した32-byte鍵が受理された。実効entropyが極端に低く総当たり・辞書化できるため、「低entropy判定が簡単に回避できない」を満たさない。

### REAUDIT-006: 過去配信

mappingなしのCOMPLETED/UNAVAILABLE/CANCELLEDは作成せず、mappingありは過去eventを更新・保持する。LIVEは仮終了時刻超過でも作成できる。しかし新規作成条件が`status in [UPCOMING,LIVE]`だけで、`UPCOMING`の`scheduledStartAt > now`を確認しない。開始08:00、仮終了09:00、現在10:00、mappingなし、status UPCOMINGでevent 1件が作成されることを再現した。

### REAUDIT-007: YouTube quota

公式仕様とのbucket分離、cost一元化、DB atomic予約、retry/pageごとの予約、失敗request消費、Pacific日付、quota不足時のno-call/cache/SKIPPED/nextRetryAtは成立する。MySQLで30並列中10件だけがbudget 10を予約し、消費後10/0になることを確認した。

ただし、channel leaseを取得できなかった処理はowner完了を待たず、freshnessを再確認せず、そのまま古いDBをCalendarへ同期して`SUCCESS`にする。二つのsubscriptionを同時実行するとYouTube callは1回だが、後続userはevent 0件のまま成功し、owner完了後もそのuserへのfan-outはない。

また、`listTrackableBroadcasts`は30日以内の未完了IDを上限なしで返し、`videoDetails`は50件ごとにrequestする。したがってGENERALは固定2 call/channel/runではない。

## 6. テスト監査

- 69件、MySQL 6件、隔離E2E 1件は実行成功したが、件数だけでは解消判定に使っていない。
- account deletion testはtimeout再開、stale writer、lease喪失後の後続step停止を検証する。Auth unit testはsignal存在だけで実際のabort eventをassertしないため、独立probeで補完した。
- MySQL quota testは`Promise.all`で30個の実SQL予約を発行し、budget 10を超えない。lease/deletion stepも実MySQLでowner/versionを確認する。
- DST testはfall-back日に次のquota日になることを確認するが、resetの正確なUTC instantまではassertしない。現実装のbinary searchはhost timezoneでなく明示IANA timezoneを使う。
- OAuth testはsleep/random注入で実時間待機せず、attempt数とRetry-Afterをassertする。
- runId testはSyncService error logとDB run IDの一致を確認する。YouTube quota loggerを横断する明示assertとCalendar gateway contextはない。
- 過去event testはCOMPLETED/UNAVAILABLE/LIVE/future UPCOMINGを扱うが、past UPCOMINGが欠落する。
- shared channel testは一つのscheduled run内の逐次処理だけで、別worker相当の真の並行実行を扱わない。
- quota計算testはretry/page/日付/reserveを扱うが、tracked IDが51件以上のbatchと24時間総量を検証しない。
- DB cleanupは専用subject/channel/date prefixへ限定される。専用空DBも開発DBと分離した。

## 7. YouTube quota再計算

2026-07-22に公式仕様を再確認した。`search.list`は専用Search Queries bucketで1 call = 1、default 100 calls/day。`channels.list`、`videos.list`、`playlistItems.list`はgeneral bucketで各1 unit。無効requestも最低1 unit、追加pageもrequestごとに消費し、midnight Pacific Timeにresetする。

参照: [Quota Calculator](https://developers.google.com/youtube/v3/determine_quota_cost)、[API Overview](https://developers.google.com/youtube/v3/getting-started)、[search.list](https://developers.google.com/youtube/v3/docs/search/list)、[videos.list](https://developers.google.com/youtube/v3/docs/videos/list)、[channels.list](https://developers.google.com/youtube/v3/docs/channels/list)、[playlistItems.list](https://developers.google.com/youtube/v3/docs/playlistItems/list)、[2026-06-01 granular quota変更](https://developers.google.com/youtube/v3/revision_history#june-1,-2026)。

現行default設定はSEARCH budget 80、GENERAL budget 8000、scheduled SEARCH reserve 72、scheduled GENERAL reserve 432でコード・`.env.example`・設計書が一致する。

3 channel × 24 run、search page上限`P=1`では正常系SEARCHは72 call/dayで正しい。GENERALの実式は各channel/runについて次である。

```text
upcoming detail = ceil(searchで得たID数 / 50)   // 0または1（P=1）
tracked detail  = ceil(30日以内の未完了ID数 / 50) // コード上限なし
GENERAL/day = 全72 channel-runの上記2項の総和
```

したがって「GENERAL 144」は、各runでupcoming IDが1〜50件かつtracked IDが1〜50件という仮定下の値であり、最大値ではない。tracked 51件なら1 channel/runのGENERALは3、3 channel × 24で216。最大3attemptなら648になりreserve 432を超える。tracked集合に上限がないため、コード上の有限な最大値は定義できない。SEARCHも正常72に対しbudget 80なので、1日で許容できるretry/追加pageは合計8 callだけである。

quota上限を超過すること自体はatomic budgetで防止されるが、報告された最大値・scheduled reserve・1時間同期保証は一致しない。

## 8. clean install結果

`pwd`が`/Users/tezuka/Desktop/products/oshi-schedule`であること、node_modulesがroot、apps 3箇所、packages 2箇所の計6箇所だけであることを確認して絶対pathで削除した。Node 22.23.1でfrozen install、Prisma生成、cache無効のtypecheck/lint/test/buildが成功した。アプリケーションコード・lockfile差分は生じていない。

## 9. migration結果

- 既存`oshi_schedule`: 4 migrations、pendingなし、schema diffなし。
- 専用空DB`oshi_schedule_final_audit_20260722`: 完全な空状態から4件を順番に適用し、status up-to-date、schema diffなし。検証後に削除した。
- MySQL integration 6件成功。quota予約30並列、lease同時取得/takeover、stale owner拒否、account deletion step fencingを含む。
- 追加migrationは既存列へのversion default追加と新規quota tableで、既存data破壊を示すSQLはない。

## 10. 新規に発見した問題

### F-01: 周期的な低entropy暗号鍵をproductionで受理する

- **重要度**: High
- **対象**: `apps/api/src/infrastructure/env.ts:96-101`
- **発生条件**: 32-byteかつ8種類以上のbyteを含むが、短い周期を繰り返した予測可能な鍵を設定する。
- **影響**: 起動時検証を通過した弱い鍵により、DB流出時のGoogle refresh token保護が実質的に弱くなる。
- **修正方針**: 既知/dev/sample鍵に加え、短周期反復・連番・代表的sampleを拒否する。運用ではCSPRNG生成とSecret Manager注入を必須化し、独自entropy推定だけを強度保証にしない。
- **必要なテスト**: `[0..7]×4`、8文字周期、連番、key ID変更sampleの拒否と、CSPRNG生成32-byte鍵の受理。

### F-02: mappingなしの過去UPCOMINGをCalendarへ新規作成する

- **重要度**: High
- **対象**: `apps/api/src/application/sync-service.ts:169-188`
- **発生条件**: YouTube/DB statusがUPCOMINGのまま、scheduledStartAtと仮endAtが現在より過去、mappingなし。
- **影響**: 初回同期・Calendar再構築で過去予定をバックフィルし、ユーザーCalendarを汚染する。
- **修正方針**: mappingなしの作成条件を`LIVE || (UPCOMING && scheduledStartAt > now)`にする。LIVEは仮終了超過でも許可する。
- **必要なテスト**: past UPCOMINGの非作成、future UPCOMING、overrunning LIVE、mapped past UPCOMINGの既存仕様確認。

### F-03: channel lease followerが新規eventを別ユーザーへ反映せずSUCCESSになる

- **重要度**: High
- **対象**: `apps/api/src/application/sync-service.ts:80-156`
- **発生条件**: 別worker/processが同一channelのleaseを保持してYouTube取得中に、別subscriptionが同時同期される。
- **影響**: YouTube callは共有されるが、後続userは古いcacheでCalendar同期を完了し、新規eventを最大次回runまで取りこぼす。履歴はSUCCESSなので検知もしにくい。
- **修正方針**: followerはbounded wait/poll後に`lastFetchedAt`を再確認してfresh dataをfan-outする。待機不能ならSUCCESSでなくDEFERRED/SKIPPEDとし、owner完了後に全subscriptionへCalendar fan-outする構造も検討する。
- **必要なテスト**: 二つのservice/worker、pause可能なYouTube gateway、同一channel・別userを真に並行実行し、YouTube call 1回かつ両Calendarにeventがあることをassertする。

### F-04: GENERAL最大値とscheduled reserveの計算が追跡batch数を含まない

- **重要度**: High
- **対象**: `prisma-store.ts:388-399`、`youtube-data-gateway.ts:215-230,290-296`、`synchronization.md`の144/432計算
- **発生条件**: 30日以内の未完了・UNAVAILABLE動画が1 channelあたり51件以上になる。
- **影響**: GENERAL実消費が文書値を超え、手動利用後に残した432 reserveだけではscheduled retryを保証できず、1時間同期が延期される。
- **修正方針**: tracked対象の明示上限/優先順位を設け、batch数を含む式でreserveを検証する。設定変更時にbudget/reserve/検索page/track limitの整合性をfail-fastする。
- **必要なテスト**: tracked 0/50/51/100件、3 channel×24 run、最大attempt、manual消費後のscheduled reserve。

### F-05: Playwrightが無関係な3000番serverを再利用する

- **重要度**: Medium
- **対象**: `playwright.config.ts:8-26`
- **発生条件**: localhost:3000に別アプリが起動した状態で非CI E2Eを実行する。
- **影響**: 別アプリを試験して失敗する。画面が偶然一致すれば誤った成功もあり得るため、E2Eの再現性を損なう。
- **修正方針**: audit/CIでは常にreuseを無効化し、専用portを設定可能にする。health endpointで本アプリ固有IDを検証する。
- **必要なテスト**: port占有時に明示失敗すること、専用portで対象appのみを試験すること。

## 11. 実サービス資格情報が必要な検証

- 実Supabase Admin DELETEの404/5xx/timeout、削除済み状態からの再実行、旧JWTの実挙動。
- 実Google OAuth callback/refresh/revoke、HTTP-date形式`Retry-After`、Calendar 404/410/409、長時間通信のabort。
- 実YouTube APIのSearch Queries/general bucket使用量、project固有割当、scheduled/upcoming応答、Cloud Console reset時刻。
- 複数hostでのprocess kill、DB failover、lease takeover、channel follower fan-out。
- Secret Managerからの鍵注入・rotation・旧ciphertext復号。
- 集約ログ基盤でのrequestId/runId/SyncRun相関。

これらはコード上のF-01〜F-04と分離したstagingブロッカーである。

## 12. 本番公開可否

**本番公開不可**。

理由は、REAUDIT-005/006/007が部分解消であり、新規High相当F-01〜F-04が残るためである。標準E2Eも環境上のport競合を安全に識別できず失敗した。隔離E2E、clean install、migration、MySQL integrationの成功だけではこれらを相殺できない。

## 13. 次に対応すべき項目

1. F-03を最優先で修正し、channel lease followerがfreshnessを待って全userへfan-outする真の並行テストを追加する。
2. F-02の新規作成条件へ`scheduledStartAt > now`を追加し、past UPCOMING回帰testを追加する。
3. F-01の周期的/既知sample鍵拒否とSecret Manager前提の生成・rotation手順を追加する。
4. F-04のtracked上限・優先順位・batch込みquota式・reserve fail-fastを実装する。
5. Playwrightを専用port/固有healthへ固定して標準`pnpm test:e2e`を再度成功させる。
6. 全修正後、Node 22 clean install、通常/MySQL/E2E、既存/空DB migrationを再実行し、その後にstaging実サービス受入へ進む。

本監査ではアプリケーションコードを変更していない。作業ツリーへ追加した永続ファイルは本レポートだけである。

## 修正着手後の追記（2026-07-22）

本レポートの原指摘は監査証跡として保持する。F-01〜F-04、部分解消REAUDIT-005〜007、F-05の修正内容・回帰テスト・検証結果は[最終監査修正台帳](./final-audit-remediation.md)で追跡する。本節は元の監査時点の公開不可判定を遡及変更しない。

修正作業は2026-07-22に完了し、台帳FINAL-001〜008はすべて修正済みとなった。Node 22.23.1 clean install、通常96件、MySQL 7件、E2E、既存/空DB migrationを再検証した。元監査の残存コード問題に対する対応後判定は、コード/DB検証範囲でCritical・High 0件である。実サービス資格情報と複数host障害注入は引き続きstaging受入項目とする。
