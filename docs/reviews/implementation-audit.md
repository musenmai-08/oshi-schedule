# 「推しスケジュール」実装監査

監査日: 2026-07-20  
対象: リポジトリ全体（要件・設計、Web、API、worker、Prisma/MySQL、テスト、運用手順）  
監査方針: アプリケーションコードは変更せず、静的照合とローカル実行結果から判定した。

## 1. エグゼクティブサマリー

レイヤー分離、JWT署名検証、所有者条件付きDB操作、AES-256-GCM、共有Channel/Broadcastモデル、Google CalendarのPATCH利用、Fake経由の主要E2Eなど、MVPの骨格は実装されている。一方で、現状を本番公開可能とは判定できない。

特に重大なのは次の4点である。

1. Prismaが生成するsubscription IDはCUIDだが、APIはUUIDだけを受理するため、実DBモードでは停止・再開・手動同期・登録解除がすべて400になる。
2. アカウント削除はローカルUserを消してからSupabase Authを消す非永続手順であり、途中失敗後の確実な再開と既発行JWTによるUser再作成を防げない。
3. Calendarイベントの管理hashが同じ場合は外部存在確認をせず終了するため、削除されたイベントやカレンダーの未来予定を再作成できない。
4. 同期はupcoming検索だけなので、開始後・終了後・検索から消えた予定を再取得できず、実績終了、中止、LIVE/COMPLETEDへの更新要件が成立しない。

検出件数は Critical 2件、High 11件、Medium 14件、Low 5件。実サービス資格情報を用いたOAuth、YouTube、Calendarの受入確認は未実施であり、上記ブロッカー解消後にも別途必要である。

## 2. 現在の完成度

| 領域               | 判定                 | コメント                                                                         |
| ------------------ | -------------------- | -------------------------------------------------------------------------------- |
| 基盤・レイヤー構成 | おおむね実装         | Web/API/worker/shared、port/adapter、Prismaが分離されている                      |
| 認証・招待         | 部分実装             | JWT/JWKS・issuer・audience・招待判定はあるが、実OAuth未検証、削除後JWT対策がない |
| 初回設定           | 部分実装             | token暗号化とCalendar作成はあるが、実サービス失敗系・UI復旧が不足                |
| チャンネル管理     | Fakeのみ主要動作     | 実DBのCUIDをAPIが拒否する                                                        |
| YouTube同期        | 不完全               | upcoming初回取得はあるが、プレミア判定とライフサイクル追跡が要件未達             |
| Calendar同期       | 不完全               | create/patch/mappingはあるが、手動削除・Calendar削除からの復旧が動かない         |
| 定期・手動同期     | 部分実装             | CLIは起動するが、分散排他、履歴、正確な状態管理がない                            |
| 再連携             | 部分実装             | token更新導線はあるが、失効判定・自動停止・ダッシュボード表示が不十分            |
| アカウント削除     | 危険                 | 外部APIを含む再開可能な状態機械が未実装                                          |
| テスト             | 最小限               | Vitest 12件、Fake E2E 1件。Web/worker/Prisma/実gatewayの検証がほぼない           |
| ドキュメント       | 量は十分、整合性不足 | 未実装項目を完了扱いし、READMEのreal起動手順も再現できない                       |

総合完成度は「Fakeデモとしては動作するが、実サービスMVPとしては未完成」と判定する。

## 3. 検証環境

- OS/ホスト: macOS arm64
- Node.js: v22.23.1（nvmで新規導入し使用）
- pnpm: 9.15.9
- Prisma / Client: 6.19.3
- MySQL: Dockerのmysql:8.4、healthy
- ブラウザ: Playwright Chromium
- Git: mainブランチにコミットが1件もなく、全プロジェクトファイルがuntracked。このため「既存コミットとの差分」や「過去に秘密がコミットされたか」は判定不能
- 実資格情報: Supabase、Google OAuth/Calendar、YouTube APIの実値なし。実サービス通信は未実施
- 秘密情報: .env実体は存在せず、.envと.env.localはgitignore対象。.env.example以外から既知の秘密鍵パターンは検出されなかった

## 4. 実行したコマンドと結果

| コマンド                                  | 結果           | 補足                                                                 |
| ----------------------------------------- | -------------- | -------------------------------------------------------------------- |
| nvm install/use 22.23.1、node -v、pnpm -v | 成功           | Node v22.23.1、pnpm 9.15.9                                           |
| CI=true pnpm install --frozen-lockfile    | 成功           | sandbox内はDNS ENOTFOUND、許可後に434 packagesを固定lockから復元     |
| pnpm typecheck（clean install直後）       | 失敗           | Prisma Client未生成のため prisma-store.ts のrowが4箇所でimplicit any |
| pnpm db:generate                          | 成功           | Prisma Client 6.19.3を生成                                           |
| pnpm typecheck（生成後、単独再実行）      | 成功           | 6 tasks                                                              |
| pnpm lint                                 | 成功           | 6 tasks。ただしNext.js ESLint plugin未検出警告あり                   |
| pnpm test（sandbox内）                    | 環境要因で失敗 | Supertestの0.0.0.0待受がEPERM                                        |
| pnpm test（許可後）                       | 成功           | API 10件、shared 2件。Web/workerはテスト0件を成功扱い                |
| pnpm build                                | 成功           | API/Web/worker。Next build成功、Next ESLint plugin未検出警告あり     |
| pnpm test:e2e                             | 成功           | Chromium 1件。Fake APIを実際に起動して登録→停止→再開→同期→解除       |
| APP_MODE=fake pnpm sync:scheduled         | 成功           | targets=0、failed=0。HTTP非依存のCLI入口を確認                       |
| prisma migrate status                     | 成功           | 1 migration、DB schemaはup to date                                   |
| prisma migrate diff                       | 成功           | 適用済みMySQLとschema.prismaに差分なし                               |

注記: typecheckとbuildを同時実行した際、Next buildが.next/typesを再生成中だったため一度だけTS6053が発生した。build完了後の単独typecheckは成功しており、これは並列実行による成果物競合である。ただし通常の品質ゲートは直列実行すべきである。

## 5. Criticalの問題

### C-01 実DBのsubscription IDをAPIが拒否する

- 重要度: Critical
- 対象ファイル・行: prisma/schema.prisma:128-130、apps/api/src/presentation/routes.ts:15, 91-121、apps/api/src/infrastructure/database/memory-store.ts:102-107、apps/api/src/app.test.ts:46-59
- 問題: PrismaはUserChannelSubscription.idをcuid()で生成するが、PATCH/DELETE/syncのpath parameterはz.string().uuid()で検証する。FakeはrandomUUID()なのでテストだけが通る。
- 発生条件: APP_MODE=realで登録し、返されたCUIDを使って一時停止、再開、手動同期、登録解除のいずれかを呼ぶ。
- 影響: 本番の主要チャンネル操作が常にVALIDATION_ERROR 400となる。公開不能。
- 修正方針: ID契約をCUIDまたはcuid2に統一し、shared/OpenAPIにも同じschemaを定義する。あるいはDB側をUUIDへmigrationするが、既存ID移行を含めて一方に統一する。
- 追加すべきテスト: Docker MySQLで実際に作成したsubscription IDを全4 endpointへ渡すAPI integration。Fakeも本番と同じID生成形式にする契約テスト。

### C-02 アカウント削除が再開不能で、削除後JWTからUserを再作成できる

- 重要度: Critical
- 対象ファイル・行: apps/api/src/application/oshi-service.ts:95-100、apps/api/src/infrastructure/auth/auth.ts:42-53、apps/api/src/infrastructure/database/prisma-store.ts:322-324、prisma/schema.prisma:226-236、apps/web/src/components/account-settings.tsx:54-65
- 問題: Calendar削除→token revoke→ローカルUser削除→Supabase Auth削除を同期直列実行し、用意されたAccountDeletionRequestを一切使わない。同モデルもUserへのCascade FKなのでUser削除後に再開記録を保持できない。Auth削除が失敗すると、JWT期限切れ後は本人が再試行できない。さらにAPIはSupabase上のUser存在を再確認せず署名済みJWTだけを受理し、各操作でensureUserするため、Admin削除後も既発行access JWTの有効期間中はローカルUserを再作成できる。
- 発生条件: ローカル削除後のSupabase Admin APIが5xx、timeout、network errorになる場合、または削除前に取得したJWTを削除後に再利用する場合。
- 影響: 削除要求が未完了のまま復旧不能、削除済みユーザーデータの再生成、削除保証・プライバシー説明への違反が起きる。
- 修正方針: supabase subjectを保持するUser非依存の削除tombstone/jobを先に作り、段階状態・attempt・errorを永続化する。外部操作を冪等化し、Auth削除完了後までローカル主体を再作成させない。JWT deny/tombstone確認、短いJWT TTL、必要に応じAuth管理APIでの存在確認を組み合わせる。
- 追加すべきテスト: 各段階での5xx/timeout、同一要求の二重実行、JWT期限前後の再試行、Auth削除後の旧JWT、404/既失効、補償worker再開を実DBとFake fault injectionで検証する。

## 6. Highの問題

### H-01 hash短絡により、削除イベントと再作成Calendarへ予定を復旧できない

- 重要度: High
- 対象ファイル・行: apps/api/src/application/sync-service.ts:53-65、apps/api/src/infrastructure/google-calendar/google-calendar-gateway.ts:50-80, 98-127
- 問題: mappingのmanagedFieldsHashが同じならCalendar APIを呼ばずcontinueする。したがって利用者がイベントを削除しても404を観測しない。Calendar自体を削除してensureCalendarが新規作成しても、古いmappingのhashが同じなので新Calendarへイベントを投入しない。
- 発生条件: 管理対象イベントまたは専用CalendarをGoogle側で手動削除し、YouTube側の管理フィールドが変化しないまま再同期する。
- 影響: 要件にあるイベント404再作成、Calendar削除検知・未来分再投入が成立しない。
- 修正方針: Calendar再作成時はそのUserのmappingを無効化する。通常同期でも存在確認戦略、定期reconciliation、またはextendedProperties検索を導入し、hash一致を「外部存在確認済み」の代用にしない。
- 追加すべきテスト: hash一致のイベント削除、Calendar削除、404/410、再作成後の全未来イベント再投入、重複なしをgateway spyで検証する。

### H-02 upcomingだけの取得では配信ライフサイクルと中止を追跡できない

- 重要度: High
- 対象ファイル・行: apps/api/src/infrastructure/youtube/youtube-data-gateway.ts:76-129、apps/api/src/infrastructure/database/prisma-store.ts:237-274、docs/requirements/product-requirements.md:13, 27-28
- 問題: 毎回eventType=upcomingだけを検索し、返却statusもrejected以外は常にUPCOMINGである。開始後はupcoming結果から消えるためactualStartTime、actualEndTime、LIVE、COMPLETEDを取得できない。検索欠落のmissingCount更新や3回連続中止処理も存在しない。uploadStatus=rejectedはアップロード拒否であり、予定中止の一般的な判定ではない。
- 発生条件: 配信が開始・終了・削除・非公開化・中止された後の定期同期。
- 影響: 仮終了時刻が実績へ直らず、Calendarが誤った終了時刻・状態のまま残る。中止予定も残存する。
- 修正方針: 既知video IDをvideos.listで追跡し、必要ならeventType=live/completedも取得する。欠落集合を保存・連続回数で扱い、明示状態と欠落推定を区別する。追跡保持期間とquota予算を設計する。
- 追加すべきテスト: UPCOMING→LIVE→COMPLETED、actual end更新、予定変更、3回欠落、中止後再出現、非公開/404、過去保持を時系列fixtureで検証する。

### H-03 プレミア公開判定がYouTube仕様に基づいていない

- 重要度: High
- 対象ファイル・行: apps/api/src/infrastructure/youtube/youtube-data-gateway.ts:97-107、docs/architecture/synchronization.md:25-27
- 問題: contentDetails.durationが存在しP0D以外ならPREMIEREとする。公式videos resourceでdurationは単に動画の長さであり、プレミアの識別子ではない。実装はsnippet.liveBroadcastContentも判定に使っていない。公式Data APIの第三者向けvideo resourceには耐久的なpremiere flagがないため、このheuristicは通常のライブやプレミアを誤分類し得る。
- 発生条件: upcomingの動画に非ゼロdurationが返る、またはプレミアにdurationが未設定/P0Dで返る場合。
- 影響: Calendarタイトル、種別、仮終了時間（30分/60分）が誤る。アプリの主要価値であるライブ・プレミア区別を保証できない。
- 修正方針: 公式に保証されたフィールドだけで確定/不明を表現し、BroadcastKindにUNKNOWN等を追加するか、YouTubeページ等の非公式判定を採るなら規約・故障時挙動・confidenceを設計する。少なくともdurationだけで確定しない。
- 追加すべきテスト: 実レスポンスを匿名化したlive/premiere fixture、duration有無、予約通常動画、誤判定時のUNKNOWN表示と仮終了戦略。
- 仕様根拠: [YouTube videos resource](https://developers.google.com/youtube/v3/docs/videos)、[search.list](https://developers.google.com/youtube/v3/docs/search/list)

### H-04 APIとworker間の同時同期をプロセス内lockで防げない

- 重要度: High
- 対象ファイル・行: apps/api/src/application/sync-service.ts:6, 31-34, 92-94、apps/worker/src/index.ts:1-8、docs/architecture/system-overview.md:27-29
- 問題: lockはJavaScriptプロセス内Setだけである。HTTP APIとworkerは元から別プロセスなので、単一replica構成でも手動同期と定期同期が競合する。DB cooldownは自動同期を排他せず、チェックと更新もatomicではない。
- 発生条件: scheduler実行中に利用者が手動同期する、workerが重複起動する、複数replicaにする。
- 影響: 同じYouTube/Calendar APIの重複呼び出し、競合更新、mapping未作成時の重複Calendarイベント。
- 修正方針: MySQL advisory lock、lease付きjob、unique running key、または分散lockをsubscription/channel粒度で取得する。取得失敗はSKIPPED/409として履歴化する。
- 追加すべきテスト: 2プロセス相当の同時開始、lease期限、worker重複、manual対scheduled、片方crash後の再取得。

### H-05 Calendar作成とmapping保存の境界で重複イベントが発生する

- 重要度: High
- 対象ファイル・行: apps/api/src/application/sync-service.ts:55-71、apps/api/src/infrastructure/google-calendar/google-calendar-gateway.ts:113-127、apps/api/src/infrastructure/database/prisma-store.ts:290-306
- 問題: Google event POST成功後にDBのsaveMappingが失敗すると、次回はeventIdを知らないため再びPOSTする。Google側作成とDB transactionをatomicにはできず、現在は決定的event ID、外部property検索、outbox/reconciliationのいずれもない。
- 発生条件: event作成成功直後のDB timeout、deadlock、process crash。
- 影響: ユーザーCalendarに重複イベントが残り、DBから片方を追跡・削除できない。
- 修正方針: YouTube video IDとuser由来のGoogle仕様適合な決定的event IDを使うか、managedBy/youtubeVideoIdで検索してから作成する。作成意図をDBに先行保存するoutbox/reconciliationも検討する。
- 追加すべきテスト: Google POST成功後のDB失敗、process再起動、再同期でeventが1件だけ、孤児eventの回収。

### H-06 refresh token失効判定と自動同期停止が誤っている

- 重要度: High
- 対象ファイル・行: apps/api/src/infrastructure/google-calendar/google-calendar-gateway.ts:14-36、apps/api/src/application/sync-service.ts:97-106、apps/api/src/infrastructure/database/prisma-store.ts:220-229
- 問題: token endpointの全非2xxをreauthRequiredにするため、429/5xx等の一時障害まで恒久失効扱いにする。一方、reauthRequired=trueのUserもlistActiveSubscriptionsから除外されず、毎時token refreshを繰り返す。AppError.retryableも実行制御で利用されない。
- 発生条件: invalid_grant、OAuth 429/5xx、一時network failureの後の定期worker。
- 影響: 不要な再連携要求、失効利用者への無限再試行、quota/ログ増加、他targetへの遅延。
- 修正方針: response bodyのOAuth errorを安全にparseし、invalid_grant等だけをreauthへ分類する。reauthRequiredはscheduled対象から除外し、再連携成功時のみ解除する。一時障害には上限付きbackoffを使う。
- 追加すべきテスト: invalid_grant、invalid_client、429、500、timeout、reauth user skip、再連携後resume。
- 仕様根拠: [Google OAuth web server / invalid_grant](https://developers.google.com/identity/protocols/oauth2/web-server)

### H-07 同期履歴・対象別結果・RUNNING状態が保存されない

- 重要度: High
- 対象ファイル・行: prisma/schema.prisma:191-224、apps/api/src/application/models.ts:46-93、apps/api/src/application/sync-service.ts:35-40, 73-89, 97-109、apps/api/src/presentation/routes.ts:124-137
- 問題: SyncRun/SyncTargetResultモデルに対するStore操作がなく、1件も書き込まれない。同期開始時にはRUNNINGではなくSUCCESSを先に保存し、失敗詳細も固定文言だけでlastErrorCodeを保存しない。sync-statusはsubscriptionの最新値だけで実行履歴ではない。
- 発生条件: すべての手動・定期同期。
- 影響: 部分失敗、実行時間、対象数、error code、相関ID、過去傾向を追跡できず、要件と監視方針を満たさない。
- 修正方針: run開始/target開始/完了を永続化し、RUNNING→SUCCESS/PARTIAL_FAILED/FAILEDをfinallyで確定する。保持期間・集計・PIIなしのerror codeを定義する。
- 追加すべきテスト: success、partial、全失敗、crashでRUNNING残存、manual/scheduled区別、retention。

### H-08 3件上限を同時登録で突破できる

- 重要度: High
- 対象ファイル・行: apps/api/src/application/oshi-service.ts:52-63、apps/api/src/infrastructure/database/prisma-store.ts:172-173, 198-201、prisma/schema.prisma:128-145
- 問題: countしてからinsertするcheck-then-actで、ユーザー単位のlock/transaction/DB制約がない。異なるchannelの並列要求は両方が上限未満を観測して作成できる。
- 発生条件: 登録数2件のUserが異なる2チャンネルを同時登録する。
- 影響: 契約上限3件を超え、quotaとUI前提が崩れる。
- 修正方針: User行lockを含むtransaction、serializable transaction、または明示slot 1..3のunique制約でDBレベルに上限を持たせる。
- 追加すべきテスト: 実MySQLへ並列登録を多数発行し、常に最大3件であることを検証する。

### H-09 既知の共通暗号鍵をreal/productionでも受理する

- 重要度: High
- 対象ファイル・行: apps/api/src/infrastructure/env.ts:16, 19-33、apps/api/src/infrastructure/encryption/aes-token-cipher.ts:8-20、.env.example:17-18
- 問題: 32-byteなら値の強度を検査せず、全ゼロの既知defaultをproductionでも受理する。READMEは置換を促すがfail-fastしない。また重複key IDはMapで静かに上書きされ、rotation設定ミスも検出しない。
- 発生条件: .env.exampleをコピーし、TOKEN_ENCRYPTION_KEYSを置換せずreal起動する。
- 影響: DB流出時に全Google refresh tokenを誰でも復号できる。
- 修正方針: real/productionで既知default・低entropy相当値を拒否し、key ID重複と形式を起動時検査する。本番はSecret Managerから注入し、rotation runbookを用意する。
- 追加すべきテスト: default拒否、重複ID拒否、複数鍵復号、旧鍵から新鍵への再暗号化。

### H-10 clean install後の品質ゲートがPrisma未生成で失敗する

- 重要度: High
- 対象ファイル・行: package.json:9-20, 22-33、turbo.json:3-8、README.md:13-18, 73-82
- 問題: pnpm install --frozen-lockfile直後にPrisma Clientが生成されず、typecheck/buildはPrisma結果型を得られない。db:generateは実サービス手順にだけ書かれ、品質確認の前提にもpostinstallにもない。今回clean再現で4件のTS7006が発生した。
- 発生条件: clean checkout/CI cacheなしでREADME冒頭のinstall後、品質コマンドを実行する。
- 影響: CI・第三者再現・デプロイbuildが失敗する。
- 修正方針: prisma generateを明示的なprepare/postinstallまたはTurboのbuild/typecheck dependencyにし、必要なdummy DATABASE_URLをCIで安全に供給する。clean CIジョブを追加する。
- 追加すべきテスト: node_modulesとgenerated clientのない状態から、記載コマンドだけでtypecheck/buildが成功するCI。

### H-11 READMEどおりの.envではAPI/worker real modeが起動しない

- 重要度: High
- 対象ファイル・行: README.md:13-18, 40-69、apps/api/src/server.ts:1-7、apps/api/src/runtime.ts:1-7、prisma.config.ts:1-7
- 問題: READMEは.env.exampleを.envへコピーしてAPP_MODE=realコマンドを実行させるが、dotenv/configを読むのはPrisma CLIだけで、API serverとworkerはprocess.envを直接parseする。Node/tsxコマンドにも--env-file指定がない。
- 発生条件: shellへ個別exportせず、READMEの実サービス手順をそのまま実行する。
- 影響: 必須変数不足でAPI/workerが起動せず、第三者がreal modeを再現できない。
- 修正方針: composition rootで一貫してdotenv/configを読み込む、Node --env-fileをscriptへ指定する、または「shellへexportする」手順へ改める。Web/API/worker/Prismaで読み込み方式を統一する。
- 追加すべきテスト: 一時.envだけを用いたAPI/workerのstartup smoke testと、missing env fail-fast。

## 7. Mediumの問題

### M-01 YouTube検索のページネーションがない

- 重要度: Medium
- 対象ファイル・行: apps/api/src/infrastructure/youtube/youtube-data-gateway.ts:5-8, 76-96
- 問題: nextPageTokenを型定義するだけで使用せず、先頭50件しか詳細化しない。
- 発生条件: 対象チャンネルのupcoming結果が50件を超える。
- 影響: 30日以内の一部予定が欠落する。
- 修正方針: nextPageTokenを辿り、詳細化後の30日境界と最大ページ/quota budgetで停止する。
- 追加すべきテスト: 2ページ、空ページ、重複ID、quota上限、30日境界。

### M-02 Calendar API呼び出しごとにaccess tokenを再発行する

- 重要度: Medium
- 対象ファイル・行: apps/api/src/infrastructure/google-calendar/google-calendar-gateway.ts:14-49, 50-160
- 問題: requestのたびにrefresh token grantを行う。Calendar確認と各event patch/create/deleteの件数だけtoken endpointを叩く。
- 発生条件: 予定数が多い同期・削除。
- 影響: OAuth endpoint負荷、遅延、一時障害面積、rate limitリスクが増える。
- 修正方針: access tokenとexpires_inをUser/実行単位で安全に短期cacheし、期限前更新する。
- 追加すべきテスト: 複数Calendar requestでrefresh 1回、期限切れ更新、並列single-flight。

### M-03 同期開始前に成功・同期時刻・manual cooldownを保存する

- 重要度: Medium
- 対象ファイル・行: apps/api/src/application/sync-service.ts:35-40, 73-90、apps/api/src/infrastructure/database/prisma-store.ts:311-320
- 問題: 外部処理前にSUCCESS、lastCalendarSyncAt、lastManualSyncAtを書き、失敗時も同じ時刻をlastCalendarSyncAtに残す。
- 発生条件: YouTube/Calendar/DB処理が途中失敗する。
- 影響: UIの「カレンダー反映」が成功時刻に見え、失敗直後も手動再試行を5分拒否する。
- 修正方針: 開始はRUNNINGとattemptedAt、成功時だけlastSuccessfulSyncAtを更新する。cooldownをattempt基準にするならUI/API名を分ける。
- 追加すべきテスト: 開始中、失敗、成功、失敗後cooldown方針、表示時刻。

### M-04 workerが部分失敗をexit 0にする

- 重要度: Medium
- 対象ファイル・行: apps/worker/src/index.ts:3-9
- 問題: 全件失敗時だけexitCode=1で、1件でも成功すると部分失敗をschedulerへ成功として返す。
- 発生条件: 複数targetの一部だけが失敗する。
- 影響: scheduler/monitoringが失敗を検知できず、通知・再実行が遅れる。
- 修正方針: 部分失敗も非0にするか、永続SyncRunとmetric/alertで必ず監視可能にする。
- 追加すべきテスト: 0件、全成功、部分失敗、全失敗のexit codeと出力。

### M-05 404と不正JSONが共通JSONエラー契約にならない

- 重要度: Medium
- 対象ファイル・行: apps/api/src/app.ts:22-38、apps/api/src/presentation/http.ts:50-70
- 問題: 未定義routeにはJSON 404 middlewareがなくExpress既定応答になる。不正JSONのSyntaxErrorは400へ分類せずINTERNAL_ERROR 500になる。
- 発生条件: 存在しないAPI path、不正なJSON body。
- 影響: API契約不一致、クライアントのresponse.json失敗、利用者入力をサーバー障害として記録する。
- 修正方針: API 404 AppErrorとbody parser SyntaxErrorの400変換をerror handler前に追加する。
- 追加すべきテスト: unknown path、不正JSON、32KiB超過、content-type違い。

### M-06 CSPが無効なのに文書は有効と記載する

- 重要度: Medium
- 対象ファイル・行: apps/api/src/app.ts:10-15、docs/security/security-policy.md:8
- 問題: HelmetでcontentSecurityPolicy:falseを明示し、Next側にもCSP設定がない。セキュリティ文書はReact escapeとCSPでXSS低減と記載する。
- 発生条件: 本番Web/API応答。
- 影響: XSS時の被害抑止層がなく、監査資料と実態も不一致。
- 修正方針: Webの実際のscript/style/connect/image先に合わせnonce/hashベースCSPを導入し、APIには不要なdirectiveを整理する。
- 追加すべきテスト: production response headerと主要画面のCSP violation確認。

### M-07 rate limitがproxy・複数replicaを考慮しない

- 重要度: Medium
- 対象ファイル・行: apps/api/src/app.ts:10-35
- 問題: trust proxy設定がなく既定memory storeを使う。reverse proxy配下では全利用者が同じIPとして制限される構成や、replicaごとに制限が分散する構成になる。
- 発生条件: Cloud Run/Railway等のproxy配下、複数API replica。
- 影響: 正常利用者の一括429または制限回避。
- 修正方針: 信頼するproxy hopを明示し、共有rate-limit storeを使う。認証subject単位とIP単位を使い分ける。
- 追加すべきテスト: forwarded IP、信頼外spoof、複数instance共有、招待外/認証前制限。

### M-08 記載された同期設定環境変数が無視される

- 重要度: Medium
- 対象ファイル・行: .env.example:19-22、apps/api/src/infrastructure/env.ts:3-17、packages/shared/src/index.ts:3-6、apps/api/src/infrastructure/google-calendar/google-calendar-gateway.ts:12、apps/api/src/infrastructure/youtube/youtube-data-gateway.ts:39
- 問題: SYNC_INTERVAL_MINUTES、YOUTUBE_MIN_FETCH_INTERVAL_SECONDS、SYNC_LOOKAHEAD_DAYS、EXTERNAL_API_TIMEOUT_MSはenv schemaになく、定数・constructor defaultで固定される。
- 発生条件: 運用者が.env値を変更する。
- 影響: 設定変更が効いたように見えて効かず、quota・timeout調整を誤る。worker自体に60分schedule機能もない。
- 修正方針: 実際に注入するか、外部scheduler管理値として削除・文書化する。未認識envを警告する。
- 追加すべきテスト: 各envのparse/境界/注入とworker設定。

### M-09 OpenAPI・既存文書・実装が同期していない

- 重要度: Medium
- 対象ファイル・行: docs/api/openapi.yaml:25-76、docs/api/api-specification.md:3, 7-20、docs/architecture/authentication.md:15, 26、docs/architecture/synchronization.md:25-40、docs/requirements/product-requirements.md:27, 36-38、docs/development/implementation-plan.md:3-24
- 問題: OpenAPIは多くのrequest/response schemaと400/401/403/5xxを欠き、API仕様の{id}と定義の{subscriptionId}も揺れる。CI smoke検査は存在しない。missingCountは要件と同期設計で矛盾し、Cookie HttpOnly、二重削除lock、同期履歴、再試行可能削除、CSP、retryable利用など未実装を実装済み/完了とする。search.list quota記載も現在の公式資料と一致しない。
- 発生条件: 文書からクライアント実装、運用判断、受入判定を行う。
- 影響: 誤った完了判断とintegration不具合。
- 修正方針: Zod/型/OpenAPIのsingle source化、endpoint contract test、要件statusの未実装明示、公式仕様の確認日更新。
- 追加すべきテスト: OpenAPI validation、全route/status/schema smoke、ドキュメント内scriptのCI実行。

### M-10 主要失敗系・実DB・Web/workerのテストがない

- 重要度: Medium
- 対象ファイル・行: apps/api/src/app.test.ts:27-79、apps/api/src/domain/scheduling.test.ts:4-34、apps/web/package.json、apps/worker/package.json、docs/testing/testing-policy.md:3-10
- 問題: APIはMemoryStore/Fake中心で、Webとworkerは0件をpassWithNoTestsで成功扱いする。Prisma integration、実gateway fixture、固定Clock、並列、部分失敗、再認証、イベント/Calendar 404、実績終了、削除途中失敗がない。MemoryStoreのUUIDがCUID問題を隠した。
- 発生条件: 本番adapter、DB、時系列・競合・障害経路の変更。
- 影響: 主要要件の破損が緑の品質ゲートを通過する。
- 修正方針: port fault injection unit、Docker MySQL integration、HTTP contract、component test、worker exit testを追加し、0 test成功を主要packageで禁止する。
- 追加すべきテスト: 本レポート各指摘のテストに加え、同時登録、未来だけ削除/過去保持、一時停止、404復旧、partial failure、再接続、削除再開。

### M-11 UTCは運用上の仮定でDB接続時に保証されない

- 重要度: Medium
- 対象ファイル・行: prisma/schema.prisma:69-71等のDateTime、docker-compose.yml:5-11、docs/database/schema.md:18
- 問題: DATETIME(3)自体はtimezoneを保持しない。DockerはTZ=UTCだが、外部MySQL/session timezoneを起動時に確認・固定する処理やrunbookがない。
- 発生条件: 本番DBまたは接続sessionのtimezoneがUTC以外。
- 影響: Prisma/DB関数・手動SQL・migration間で時刻解釈がずれ、30日境界やcooldownが誤る。
- 修正方針: DB/session timezoneをUTCへ明示設定し、startup healthで検査する。時刻契約を運用文書へ追加する。
- 追加すべきテスト: JST/UTC DB sessionで同じinstant、DST地域、ミリ秒精度。

### M-12 再認証・onboarding失敗をダッシュボードが表示しない

- 重要度: Medium
- 対象ファイル・行: apps/web/src/app/auth/callback/route.ts:7-29、apps/web/src/components/dashboard.tsx:41-62, 102-138、apps/web/src/components/account-settings.tsx:26-53
- 問題: callbackはsetup=failed/reauthを付けるがDashboardはqueryも/meも読まない。reauthRequiredはSettingsのchipでのみ分かり、load前は接続済み表示になる。ダッシュボードでの再連携要求を満たさない。
- 発生条件: provider_refresh_token不在、onboarding API失敗、workerがreauthRequiredを立てた場合。
- 影響: 同期が止まっても利用者が理由と復旧導線に気づきにくい。
- 修正方針: Dashboardで/meとsetupを扱い、blocking bannerと再同意導線を出す。callbackの安全なエラーcodeを伝える。
- 追加すべきテスト: refresh token不在、onboarding 5xx、reauth flag、再接続成功後のbanner消去。

### M-13 登録時の全DB例外を「重複」に変換する

- 重要度: Medium
- 対象ファイル・行: apps/api/src/application/oshi-service.ts:57-64
- 問題: createSubscriptionの例外種別を見ず、接続断・FK違反・timeoutもDUPLICATE_CHANNEL 409にする。
- 発生条件: insert時のunique違反以外のDB障害。
- 影響: 利用者と監視が障害を誤認し、retry/alert判断を誤る。
- 修正方針: Prismaの既知unique errorだけを409へ変換し、他は安全な500/503としてcauseを構造化ログへ残す。
- 追加すべきテスト: duplicate、DB unavailable、FK、timeoutの分類。

### M-14 利用規約・プライバシー・削除URLが未提供

- 重要度: Medium
- 対象ファイル・行: apps/web/src/app/page.tsx:59-61, 105-117、README.md:107-109、docs/security/security-policy.md:15-17
- 問題: 同意文言はあるがリンク先が#で、実文書・運営連絡先・公開データ削除URLがない。
- 発生条件: OAuth審査または外部利用者への公開。
- 影響: 利用者が処理目的・保持・削除方法を確認できず、Google公開審査と公開準備を妨げる。
- 修正方針: 実URLの規約、privacy、データ削除説明、問い合わせ先を用意し、OAuth同意画面と一致させる。
- 追加すべきテスト: productionで全footer/consent/delete URLが200かつ#でないこと。

## 8. Lowの問題

### L-01 手動同期は同期完了後に202を返す

- 重要度: Low
- 対象ファイル・行: apps/api/src/presentation/routes.ts:113-122
- 問題: 処理をawaitして完了結果を返すのにAccepted 202を使う。
- 発生条件: 手動同期成功時。
- 影響: 非同期jobとしてpollが必要だとクライアントが誤解する。
- 修正方針: 同期実行なら200、job化するなら202とstatus URLに統一する。
- 追加すべきテスト: 採用した応答semanticとOpenAPI。

### L-02 登録前のhandle確認だけで共有Channelを永続化する

- 重要度: Low
- 対象ファイル・行: apps/api/src/application/oshi-service.ts:42-45
- 問題: resolveが確認専用でもDB upsertする。
- 発生条件: 利用者が検索して登録をキャンセルする、または大量検索する。
- 影響: 未使用Channelが蓄積する。
- 修正方針: register時に検証済み結果を再解決/署名tokenで渡すか、未参照Channel retentionを設ける。
- 追加すべきテスト: resolve後未登録のretention。

### L-03 期待される4xxもerror levelで記録する

- 重要度: Low
- 対象ファイル・行: apps/api/src/presentation/http.ts:57-66
- 問題: 401、403、404、validation、cooldownもすべてlogger.errorになる。
- 発生条件: 通常の認証切れ・入力誤り。
- 影響: alert noiseと本当の5xxの埋没。
- 修正方針: 4xxをinfo/warn、5xxをerrorへ分類しmetricを分ける。
- 追加すべきテスト: status別log levelと秘密値非出力。

### L-04 Settings読込中に「接続済み」と表示する

- 重要度: Low
- 対象ファイル・行: apps/web/src/components/account-settings.tsx:26-39, 85-105
- 問題: meがnullでもreauthRequiredがfalse相当になりsuccessの「接続済み」を表示する。
- 発生条件: 初回load中または/me失敗時。
- 影響: 短時間またはエラー時に誤った接続状態を示す。
- 修正方針: loading/unknown/errorを別状態にする。
- 追加すべきテスト: loading、API error、not connected、reauth。

### L-05 Node 22方針とlint構成が不完全

- 重要度: Low
- 対象ファイル・行: apps/api/package.json、apps/web/package.json、apps/worker/package.json、packages/eslint-config/index.js:1-14、apps/web/eslint.config.mjs:1-2
- 問題: 各appは@types/node 20系を使い、Web lintはNext.js/React hooks/accessibility pluginを含まない。Next buildもplugin未検出を警告した。
- 発生条件: Node 22固有API利用、Next/React規約違反、アクセシビリティ退行。
- 影響: runtime/type定義差と検出漏れ。
- 修正方針: 対応するNode型へ統一し、Next公式flat config、hooks、jsx-a11y相当を導入する。
- 追加すべきテスト: lint fixtureまたはCIでNext警告ゼロ、主要画面axe検査。

## 9. 要件ごとの実装状況

凡例: 実装済み = コードとテスト/静的根拠あり、部分 = 主経路のみ、未達 = 要件を満たす処理なし、未検証 = 実資格情報が必要。

| 要件                                | 状況                       | 根拠・不足                                                                      |
| ----------------------------------- | -------------------------- | ------------------------------------------------------------------------------- |
| Supabase Google OAuth / PKCE        | 部分・実サービス未検証     | @supabase/ssr callbackあり。明示flowTypeはないがSSR client経由。実project未検証 |
| Calendar scope / offline / consent  | 実装済み・未検証           | login-button.tsxとaccount-settings.tsxで指定                                    |
| provider refresh token取得・暗号化  | 実装済み・未検証           | callback→onboarding→AES-GCM。実レスポンス未確認                                 |
| access token更新                    | 部分                       | refresh grantあり。ただし毎request、失効分類不良                                |
| JWT署名/iss/aud/exp/sub/email       | 実装済み・未検証           | jose jwtVerify/JWKS。実Supabase key rotation未確認                              |
| 招待メール制限                      | 実装済み                   | 正規化完全一致、APIテストあり                                                   |
| User作成・Calendar初回設定          | 部分                       | ensureUser/upsertあり。実Calendar、障害系未検証                                 |
| @handle解決・確認・登録             | 部分                       | Fakeでは動作、real YouTube未検証                                                |
| 最大3件                             | 未達                       | 直列では動くが並列競合あり                                                      |
| 重複登録                            | 実装済み                   | DB uniqueあり。ただし例外分類不良                                               |
| 一時停止・再開・解除                | Fakeのみ                   | real IDがCUIDのためAPIで拒否                                                    |
| 共有Channel保持                     | 実装済み                   | Channel FK Restrict、subscription deleteで保持                                  |
| ライブ予定 / 30日                   | 部分                       | upcoming取得後filterあり                                                        |
| プレミア判定                        | 未達                       | duration heuristicは公式仕様にない                                              |
| 通常予約動画除外                    | 部分                       | eventType upcomingで絞るが実fixture未検証                                       |
| チャンネル取得共有 / 5分cache       | 部分                       | lastFetchedAtあり。並列workerでは重複                                           |
| video ID一意                        | 実装済み                   | DB unique                                                                       |
| pagination / quota                  | 未達                       | 50件固定、履歴/metricなし                                                       |
| Calendar create/update/hash/mapping | 部分                       | 通常経路あり。外部/DB境界で重複余地                                             |
| title/start/end変更反映             | 部分                       | upcoming中は反映可能、開始後は追跡しない                                        |
| 仮終了→実績終了                     | 未達                       | completed itemを取得しない                                                      |
| event 404 / Calendar削除復旧        | 未達                       | hash一致continueで検知不能                                                      |
| 非管理項目保持                      | 実装済み                   | PATCHで管理項目のみ指定                                                         |
| 登録解除時未来だけ削除、過去保持    | 部分                       | endAt基準で処理、実Calendarテストなし                                           |
| 一時停止時既存event保持             | 実装済み                   | statusだけ変更し削除しない                                                      |
| HTTP非依存worker                    | 実装済み                   | Fake CLI起動成功                                                                |
| 手動5分制限                         | 実装済みだが時刻意味に問題 | APIテストあり、失敗時もcooldown                                                 |
| 同時実行・二重同期防止              | 未達                       | process内だけ                                                                   |
| 部分失敗継続                        | 部分                       | loop catchあり。履歴/exit code不足                                              |
| 同期履歴 / dashboard状態            | 未達・部分                 | SyncRun未使用、subscription最新値のみ                                           |
| refresh失効・自動停止               | 未達                       | 全非2xxを失効扱い、flag後も実行                                                 |
| 再連携と利用者表示                  | 部分                       | Settings導線あり、dashboard表示なし                                             |
| account deletion全段階              | 危険                       | happy pathのみ。再開、二重実行、旧JWT対策なし                                   |

## 10. セキュリティ監査結果

良好な点:

- JWTはdecodeだけでなくremote JWKSを用いたjwtVerifyで署名、issuer、audience、有効期限を検証する。
- resource操作はJWT主体から解決した内部userIdとsubscription IDを同時条件にし、明白なIDORは確認されなかった。
- refresh tokenはAES-256-GCM、12-byte random IV、auth tag付きで暗号化され、平文DB保存はない。
- secret/service role/client secretはNEXT_PUBLIC変数へ入っていない。
- CORSは単一WEB_ORIGIN、JSONは32KiB、raw queryは使わず、error responseにstack/bodyを出さない。
- .env/.env.localはignoreされ、実secretらしい文字列は検出されなかった。

要修正:

- C-02の削除後JWT、H-09の既知暗号鍵default、M-06のCSP、M-07のrate limitが主なリスク。
- Supabase SSR cookieをHttpOnlyとする文書記載は実態・Supabase公式方針と一致しない。ブラウザ側session refreshのためHttpOnlyではない設計を前提に、XSS/CSPと短いtoken寿命を説明すべきである。[Supabase cookie guidance](https://supabase.com/docs/guides/troubleshooting/how-do-i-make-the-cookies-httponly-vwweFx)
- APIはJWTのemailが招待一覧にあることだけを確認する。実SupabaseでGoogle以外のprovider、匿名、未確認emailを無効にし、必要ならamr/app_metadata/email_verified相当を契約化する。
- fetch error本文やtokenは現在ログに出していない。今後OAuth error parseを追加する際もtoken・外部本文全体をログに出さないこと。

## 11. DB・トランザクション監査結果

- schema.prisma、初期migration、適用済みMySQLは一致し、migrate statusとdiffは成功した。
- user-channel、video ID、user-broadcast mapping等の重要な一意制約と主要indexは存在する。
- Channel/Broadcastは共有資源でonDelete Restrict、User固有のcredential/calendar/subscription/mappingはCascadeで、共有保持方針は妥当。
- pause状態、仮終了flag、actual start/endは表現できる。
- 外部API呼び出し中に長時間DB transactionを保持していない点は良い。
- ただしCUID/UUID契約、3件上限競合、Calendar作成とmapping保存、削除状態modelのCascade、UTC保証が未解決。
- SyncRun retention job/partition/archive方針はなく、実際には書き込み自体もない。履歴実装時に保持期間とindex運用を決める必要がある。
- GoogleCredential.keyId列はあるが、decryptは暗号文本体のkey IDを使いDB列を照合しない。破損検知・rotation棚卸しで両者の整合を確認する設計が望ましい。

## 12. 同期処理監査結果

良好な点:

- UseCaseはExpressやPrismaへ直接依存せず、YouTube/Calendar/Store/Clock/Logger portへ依存する。
- YouTube video IDと(userId,broadcastId)の一意制約、managed field hash、Calendar PATCHにより通常経路の冪等性を意図している。
- 他Userの同期失敗をrunScheduled loopでcatchし継続する。
- 30日filter、5分fetch cache、10秒timeout、未来eventだけの登録解除処理が存在する。

不成立または弱い点:

- H-01からH-07が中核。特に「hash一致=外部event存在」とみなすこと、upcomingだけで全状態を扱うこと、process内lockだけで外部副作用を守ることは修正が必要。
- search.listにはpageTokenがあり、公式資料上は追加ページごとにquotaを消費する。ページ上限とquota budgetを同時に設計する。[YouTube search.list](https://developers.google.com/youtube/v3/docs/search/list)
- Calendar events.patchは指定fieldだけを置換するので非管理項目保持には適するが、1 patchが複数quota unitを消費するという公式注意もあり、hash skipと存在reconciliationを別周期にする余地がある。[Google Calendar events.patch](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch)

## 13. テスト監査結果

現在の有効な自動テスト:

- shared unit: 2件（handle schema）
- API package: 10件（暗号1、schedule3、Supertest6）
- Web unit/component: 0件
- worker unit: 0件
- Playwright: 1件
- Prisma/MySQL integration: 0件
- 実Supabase/Google/YouTube contract: 0件

既存テストはexpect(true)型ではなく、Fake APIを実起動するE2Eも主要画面フローを操作している。反面、FakeのUUID、本番と異なる外部失敗、固定されないClock、DBなしにより、本番固有の欠陥を隠している。

依頼で指定された不足テストの状況:

| ケース                                                           | 状況     |
| ---------------------------------------------------------------- | -------- |
| 未認証、招待外、直列3件上限、重複、他User、pause/resume、手動5分 | 既存あり |
| 同時登録                                                         | 不足     |
| 未来eventだけ削除、過去保持                                      | 不足     |
| event 404、Calendar削除再作成                                    | 不足     |
| refresh token無効、Google再連携                                  | 不足     |
| 同時同期、API-worker競合                                         | 不足     |
| 部分失敗                                                         | 不足     |
| 仮終了                                                           | unitのみ |
| 実績終了への更新                                                 | 不足     |
| account削除途中失敗・再実行・旧JWT                               | 不足     |
| real CUID endpoint                                               | 不足     |

優先順位は、実MySQL contract、同期service fault injection、YouTube実fixture、Calendar 404/reconciliation、account deletion state machine、Web再認証UI、worker exit codeの順が妥当である。

## 14. ドキュメント監査結果

- READMEのFake起動とE2Eは再現できる。
- READMEのreal起動は.env読込不足で再現できず、clean品質手順はPrisma生成不足で一度失敗する。
- product requirementsはmissingCountを3回で中止とし、synchronization docは将来予約としており矛盾する。
- authentication/security docsのHttpOnly、二重送信lock、再開可能削除、CSP、retryable利用、syncRunId logは実装と一致しない。
- implementation planは全phaseを完了とするが、本監査のCritical/High項目と矛盾する。
- OpenAPIは概要レベルで、実クライアント生成や契約検査に使える完成度ではない。
- DB設計書のモデル一覧はschemaと一致するが、「用途」として記載したSyncRun/DeletionRequestは実処理から未使用である。
- READMEは本番前未検証を一定程度明記している点は良い。ただし公開ブロッカーの具体的な未実装状態を追記すべきである。

## 15. 推奨修正順序

1. C-01を修正し、実MySQL API contract testを追加する。
2. C-02の永続削除state machine/tombstoneと旧JWT拒否を設計・実装する。
3. H-01、H-04、H-05をまとめて、Calendar reconciliationとDB/分散排他による副作用冪等性を確立する。
4. H-02、H-03でYouTubeの既知video追跡、状態遷移、premiere不明表現を決める。
5. H-06、H-07でreauth停止と同期履歴・監視を実装する。
6. H-08、H-09でDB競合と暗号鍵fail-fastを塞ぐ。
7. H-10、H-11でclean install、env読込、CI/deploy再現性を直す。
8. MediumのAPI契約、rate limit、CSP、UI、テスト、文書を整合させる。
9. 実Supabase/Google/YouTubeのstaging受入とOAuth審査準備を実行する。

## 16. 本番公開を妨げるブロッカー

- C-01: real DBで主要subscription操作不能
- C-02: account deletionの安全性・再開性・削除後session制御不足
- H-01: 手動削除されたCalendar/eventを復旧不能
- H-02/H-03: 実績終了・中止・プレミア分類が要件未達
- H-04/H-05: API-worker競合と外部/DB途中失敗で重複eventの可能性
- H-06: 失効時の自動停止がなく、一時OAuth障害も誤分類
- H-09: 既知暗号鍵defaultを本番で受理
- H-10/H-11: clean buildとreal env起動の再現性不足
- 実サービス資格情報によるOAuth/Calendar/YouTube受入未実施
- 利用規約、プライバシーポリシー、公開データ削除URL、運営連絡先、監視、backup、scheduler/deployment定義が未整備

結論: 現在は本番公開不可。Fakeデモまたは限定的な内部検証に留める。

## 17. 実サービス接続時に確認すべき項目

### Supabase / Google OAuth

- 実Google providerでPKCE、state、callback、招待内外、issuer/audience/JWKS rotationを確認する。
- 初回・再同意時のprovider_refresh_token有無、offline/prompt=consent、scope増減を確認する。
- JWT TTL、User削除後のaccess/refresh token、Google以外のprovider無効化、email確認設定を確認する。
- invalid_grant、invalid_rapt、revoked、429、5xx、timeoutを区別する。

### YouTube

- 実際の第三者ライブ・プレミア・予約通常動画の匿名化fixtureを収集し、duration heuristicを廃止した契約を確認する。
- upcoming/live/completed、予定変更、削除/非公開、中止、actualStart/End、50件超ページを確認する。
- 現行quota consoleと公式資料でsearch/videos/channelsの予算、日次上限、複数ページ、cache hit率を計測する。

### Google Calendar

- Calendar作成、PATCHで利用者追加fieldが残ること、event/Calendar 404・410再作成、既失効tokenを確認する。
- POST成功後DB失敗、DB成功前process crash、同時worker/manualでもeventが1件だけであることを確認する。
- Calendar削除、登録解除、account削除で過去eventと未来eventの境界を確認する。
- refresh access token cache、Calendar quota、429/5xx backoffを確認する。

### DB / 運用

- clean production migration、rollback/restore、backup、UTC session、connection pool、deadlockを確認する。
- 3件並列登録、同時同期、scheduler重複起動、worker crash、lease回収、SyncRun retentionを負荷試験する。
- Secret Manager、暗号鍵rotation、旧鍵再暗号化、log redaction、alert、部分失敗exit/metricを確認する。
- production build/start command、health/readiness、graceful shutdown、Docker/Cloud Run等の実配備定義を追加してsmoke testする。

---

監査で変更した永続ファイルは本ファイルのみである。依存関係、Prisma Client、Next/Turbo/Playwrightの通常生成物・cacheは検証のため作成されたが、アプリケーションコード、既存文書、設定、テストは変更していない。
