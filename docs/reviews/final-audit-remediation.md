# 最終独立監査 High 修正台帳

作成日: 2026-07-22  
基準: [Critical・High 最終独立監査](./final-critical-high-audit.md)

| ID        | 重要度 | 問題 | 発生条件 | 根本原因 | 修正対象 | 回帰テスト | 状態 |
| --------- | ------ | ---- | -------- | -------- | -------- | ---------- | ---- |
| FINAL-001 | High | REAUDIT-005: 周期的・連番・sample暗号鍵をproductionで受理 | 32-byteかつ8種類以上だが予測可能な鍵 | unique byte数だけを強度判定にした | env、cipher、README、security | random/短長/sample/反復/連番/不正base64/rotation/tag | 修正済み |
| FINAL-002 | High | REAUDIT-006: mappingなしの過去UPCOMINGを新規作成 | 予定・仮終了が過去、status UPCOMING | statusだけで新規作成可否を決める | Calendar作成判定、SyncService | 状態×mapping×時刻のtable test、冪等性 | 修正済み |
| FINAL-003 | High | REAUDIT-007: quota最大値が追跡件数により無制限 | 30日内の未完了IDが50件超 | tracking件数・期間・run上限がない | env、quota計算、Store query、gateway | 0/50/51/100件、batch、日次上限 | 修正済み |
| FINAL-004 | High | F-01: 低entropy鍵検証を容易に回避できる | `[0..7]`等の短周期鍵 | FINAL-001と同根 | env、cipher | 周期/連番/key ID変更sample拒否 | 修正済み |
| FINAL-005 | High | F-02: 過去UPCOMING誤作成 | 初回同期・mappingなし | FINAL-002と同根 | SyncService | past UPCOMING非作成 | 修正済み |
| FINAL-006 | High | F-03: channel lease followerがeventなしSUCCESS | 別workerが同一channel取得中 | snapshot完了を待たず古いDBで続行 | schema、Store、SyncService、API状態 | MySQL 2 worker・2 user、延期、再開、冪等 | 修正済み |
| FINAL-007 | High | F-04: GENERAL 144/reserve 432がbatch数を含まない | tracked 51件以上 | 有限上限と設定整合性検証がない | quota helper、env、docs | 最大retry・manual reserve・fail-fast | 修正済み |
| FINAL-008 | Medium | E2Eが無関係な3000番serverを再利用 | localhost:3000が占有済み | 共用portとreuseExistingServer | Playwright、health、test docs | 3000占有下、連続2回、固有health | 修正済み |

状態を修正済みにするのは、関連回帰テスト、MySQL並行テスト、clean install、全品質ゲート、既存/空DB migrationが成功した後とする。既存migrationは変更しない。

## 修正内容と根拠

### FINAL-001 / FINAL-004（暗号鍵）

- 厳密なbase64 canonical形式と復号後32 byteを共通decoderで検証した。
- production/realでは開発sample、同一byte、16種類未満、1〜16 byteの短周期、等差連番を拒否する。これはCSPRNG生成を代替するentropy推定ではなく、既知の危険入力をfail-fastする防御である。
- 暗号文のkey ID、旧鍵復号、先頭の新鍵による再暗号化、不明key ID、誤鍵/tag失敗を検証した。鍵・平文はログへ渡さない。
- 対象: `aes-token-cipher.ts`、`env.ts`、両test、README、`.env.example`、認証/security文書。
- 残存リスク: Secret Manager上の実rotationはstaging運用受入。コード上は新旧鍵併存と再暗号化が可能。

### FINAL-002 / FINAL-005（過去配信）

- `shouldSyncCalendarEvent`へ状態、mapping、予定開始、実終了、現在時刻の判定順を集約した。mappingなしは未来UPCOMINGかactualEndAtのないLIVEだけを作成する。
- mappingありはCOMPLETED/UNAVAILABLE/過去状態の更新を維持し、仮終了超過だけではLIVEを終了扱いしない。
- 状態×mappingのtable test、past UPCOMING fixture、2回同期の冪等性を追加した。
- 対象: `domain/scheduling.ts`、`sync-service.ts`とtest、同期文書。
- 残存リスク: YouTube自体が誤ったUPCOMINGを返す場合も、予定開始が過去なら新規Calendarを作らない。

### FINAL-003 / FINAL-007（quota上限）

- 追跡を既定50件/チャンネル・30日へ制限し、COMPLETED/CANCELLEDを除外、新しい予定開始順で選択する。設定上限は250件/90日である。
- `videos.list`は重複IDを除き50件ずつbatch化する。0/50/51/100件を検証した。
- `P=maxSearchPages`、`T=maxTracked`、`B=ceil(T/50)`として通常SEARCH=`72P`、GENERAL=`72(P+B)`、retry最大はこれにattempt数を乗じる。既定は通常72/144、SEARCH budgetでの打切り前理論値216、GENERAL reserve 432である。
- production設定はGENERAL retry reserveと通常SEARCH reserveの不足を起動時拒否する。手動予約はDBのscheduled reserveを侵食せず、複数worker予約もatomicである。
- 対象: env、quota helper/gateway、Memory/Prisma Store、test、README/同期文書。
- 残存リスク: API呼出し後のprocess crashで未使用予約が当日残る。二重消費より安全側を選び、Pacific Timeの翌日行で分離する。

### FINAL-006（共有channel並行同期）

- YouTubeChannelへ取得開始/完了/最終成功、status、nextFetchAt、snapshotVersionを追加した。
- channel lease所有者だけが、leaseをtransaction内でfenceしてBroadcast更新とsnapshotVersion増分を原子的に確定する。
- 後続workerは開始時versionより新しい成功snapshotをbounded pollし、その後も自分のsubscriptionのCalendar同期を実行する。完了snapshotがなければCalendar cache処理後も`DEFERRED`であり`SUCCESS`にしない。
- SyncTargetResultへYouTube取得・DB更新・Calendar同期のphaseと使用versionを保存した。定期runはDEFERRED/PARTIAL_SUCCESSも集約する。ユーザー別決定的event IDとmapping一意制約は維持した。
- Memory真並行testと、別PrismaClientを使うMySQL 2 worker/2 user testで、YouTube 1回、両Calendar event、両SUCCESS、version一致を確認した。取得前DEFERRED、quota cache、1ユーザー失敗隔離、再実行冪等、lease takeoverも既存/追加testで確認した。
- 対象: schema/追加migration、Store、SyncService、shared/API/OpenAPI、test、DB/同期文書。
- 残存リスク: 複数hostの強制killとDB failoverはstaging受入。ただし期限切れlease takeoverとstale owner拒否は実MySQLで検証済み。

### FINAL-008（E2E再現性）

- Web 3310/API 4310を安全な既定専用portとし、両serverとも`reuseExistingServer=false`。環境変数でCI job別portを割り当てられる。
- API `/health`へ`service=oshi-schedule-api`を追加し、E2E本体がシナリオ前にidentityを検証する。
- 3000番で別Viteアプリがlisten中のまま標準E2E成功、連続2回成功、各終了後3310/4310 listenerなしを確認した。
- 対象: `playwright.config.ts`、API health/test、E2E test、README/testing文書。
- 残存リスク: portの中央割当はCI設定責任。衝突時は既存processを再利用せず起動失敗として検出する。

## migration

既存migrationは変更せず、`20260722120000_final_audit_remediation`を追加した。既存DBでは旧`lastFetchedAt`があるchannelを成功snapshot version 1へ移行し、null行はNEVER/version 0を保つ。既存DBと専用空DBの双方で全5 migration、status up-to-date、Prisma schema差分なしを確認した。専用検証DBは確認後に削除した。

## 最終検証

Node.js 22.23.1、pnpm 9.15.9、MySQL 8.4を使用した。

| 検証 | 結果 |
| ---- | ---- |
| 6箇所のproject内`node_modules`削除、`CI=true pnpm install --frozen-lockfile` | 434 packages、lockfile差分なし、Prisma生成成功 |
| cacheなしtypecheck | 6/6成功 |
| cacheなしlint | 6/6成功 |
| cacheなし通常test | API 93 + shared 3 = 96成功、MySQL 7はURL未指定でskip |
| cacheなしbuild | 4/4成功（既存Next ESLint plugin warningのみ） |
| MySQL integration | 7/7成功。共有snapshot並行、quota並行予約、lease/fencingを含む |
| `pnpm test:e2e` | 1/1成功。3000番別アプリ稼働下、専用3310/4310、固有health |
| E2E連続2回・終了確認 | 2/2成功、3310/4310 listenerなし |
| E2E対象server起動失敗 | 3310をダミー占有すると`already used`で期待どおり失敗、cleanup後listenerなし |
| `pnpm sync:scheduled` | target 0、failed 0、空run SUCCESS |
| 既存DB migration/status/diff | 5件、up-to-date、差分なし |
| 専用空DB migration/status/diff | 5件を初回適用、差分なし。検証DB削除済み |

通常96 + MySQL 7 + E2E 1 = **104 tests**が成功した。Git commitは作成していない。上記コード・DB検証の範囲で既知Critical/Highは0件である。実Supabase/Google/YouTube、Secret Manager、本番quota割当、複数host kill/failoverはstaging/運用受入として残る。
