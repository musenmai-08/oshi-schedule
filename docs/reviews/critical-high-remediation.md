# Critical・High 修正台帳

作成・完了日: 2026-07-20  
基準: [実装監査](./implementation-audit.md)

| ID        | 重要度   | 問題                                                        | 根本原因                                                     | 修正対象                                                | 回帰テスト                                                      | 状態     |
| --------- | -------- | ----------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------- | --------------------------------------------------------------- | -------- |
| AUDIT-001 | Critical | アカウント削除が再開不能で、削除後JWTからUserを再作成できる | 進捗がcascade対象Userに従属し、通常APIも暗黙にUserを作成した | deletion tombstone、OshiService、Store、Auth admin、Web | 段階失敗・再開・同時/反復実行・旧JWT・他User・実MySQL墓石       | 修正済み |
| AUDIT-002 | Critical | 実DBのCUIDをAPIのUUID検証が拒否する                         | DB、HTTP、FakeでID契約が不一致だった                         | shared Zod、route、MemoryStore、OpenAPI                 | Prisma生成CUIDのpause/resume/sync/delete、所有権、400/404       | 修正済み |
| AUDIT-003 | High     | hash一致時に削除event・再作成Calendarを復旧できない         | hashを外部存在確認の代用にした                               | SyncService、Calendar port/gateway                      | event/Calendar 404・410、hash一致、mapping差替                  | 修正済み |
| AUDIT-004 | High     | upcomingだけでは開始後・終了後・中止を追跡できない          | 既知video IDの詳細再取得と状態正規化がなかった               | YouTube port/gateway、Store、SyncService、schema        | upcoming/live/completed/unavailable、一時失敗、実終了、差分なし | 修正済み |
| AUDIT-005 | High     | プレミア判定がduration heuristicだった                      | APIに確定fieldがない状態を二値へ推測した                     | BroadcastKind、YouTube gateway、Calendar表示、schema    | duration非依存UNKNOWN、live、通常動画除外                       | 修正済み |
| AUDIT-006 | High     | APIとworker間のprocess内lockが効かない                      | 排他状態がJavaScriptプロセス内だけだった                     | SyncLease、Memory/Prisma Store、SyncService             | 競合同期、owner更新、lease延長・解放、実MySQL競合               | 修正済み |
| AUDIT-007 | High     | Calendar POST後のmapping失敗で重複する                      | 外部event IDが非決定的でDB保存とatomicにできなかった         | SyncService、Calendar gateway、決定的event ID           | POST後DB失敗、409→PATCH、再試行event 1件                        | 修正済み |
| AUDIT-008 | High     | refresh token失効分類と自動停止が誤る                       | OAuth全非2xxを失効扱いにし、reauth Userも列挙した            | Google gateway、Store、SyncService                      | invalid_grant/client、429/500/timeout、3回上限、skip/reconnect  | 修正済み |
| AUDIT-009 | High     | 同期履歴・RUNNING・対象結果を保存しない                     | SyncRunモデルがuse caseへ接続されていなかった                | Store、SyncService、SyncRun/Target                      | success/partial/all failed、stale RUNNING回収、90日retention    | 修正済み |
| AUDIT-010 | High     | 3件上限を並列登録で突破できる                               | countとinsertがatomicでなかった                              | PrismaStore、OshiService                                | 実MySQL並列登録で201/422、合計3件                               | 修正済み |
| AUDIT-011 | High     | 既知の共通暗号鍵をproductionで受理する                      | env検証が存在・長さだけだった                                | env、AesTokenCipher                                     | default鍵・重複key ID拒否、非default鍵                          | 修正済み |
| AUDIT-012 | High     | clean install直後にPrisma未生成で失敗する                   | install/build/typecheck graphにgenerateがなかった            | package scripts、Prisma config、README                  | lifecycle契約、完全clean install後の全品質ゲート                | 修正済み |
| AUDIT-013 | High     | READMEどおりのroot .envをAPI/workerが読まない               | dotenv読込がPrisma CLIだけだった                             | API env、api package、README                            | root path契約、apps/api cwdから実起動・health                   | 修正済み |

## 実装結果

- アカウント削除要求はSupabase subjectを一意キーにする墓石としてUser削除後も保持する。各外部/内部stepの完了時刻を保存し、外部呼び出しをDB transaction外で行う。通常APIは暗黙にUserを作らず、墓石があれば410にする。同時削除はDB leaseで直列化する。
- subscription IDはPrisma CUIDを正とし、shared Zod、HTTP path、Fake、OpenAPIを統一した。実MySQLが生成したIDで主要4操作と所有権境界を検証した。
- Calendarはhash一致時もeventを存在確認し、削除event/Calendarをreconcileする。新規event IDを決定的にし、mapping保存失敗後の409をPATCHへ収束させる。登録解除は未来eventのGoogle削除後だけmappingを消す。
- YouTubeはupcoming検索に加えて保存済み未完了video IDを詳細再取得し、LIVE/COMPLETED/UNAVAILABLEと実終了時刻を反映する。第三者Data APIだけで確定できないpremiere種別は推測せずUNKNOWNにする。
- API/worker共通の`SyncLease`をMySQLへ保存し、同期ループ中に延長する。`SyncRun`/`SyncTargetResult`はRUNNINGから最終状態へ遷移し、24時間超のstale RUNNINGをFAILEDへ回収、完了履歴は90日保持する。
- OAuth `invalid_grant`だけを再認証へ分類する。429/5xx/network timeoutは指数的delayを入れて最大3回に制限し、reauth Userはscheduled対象から外して再連携後に復帰させる。
- 3件上限はUser行をlockするserializable transaction内のcount+insertと一意制約で守る。production/realは既知の開発鍵を拒否し、暗号鍵ID重複も拒否する。
- `postinstall`、`pretypecheck`、`prebuild`でPrisma Clientを生成する。API/workerはcwdに依存せずproject rootの`.env`を読む。

## 検証結果

環境はNode.js v22.23.1、pnpm 9.15.9、Docker MySQL 8.4、Playwright Chromiumを使用した。

| 検証                                            | 結果                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| 対象node_modulesだけを削除した完全clean install | `CI=true pnpm install --frozen-lockfile`成功、postinstallでPrisma生成      |
| `pnpm db:generate`                              | 成功                                                                       |
| `pnpm typecheck`                                | 6/6 tasks成功                                                              |
| `pnpm lint`                                     | 6/6 tasks成功                                                              |
| `pnpm test`                                     | 43件成功。MySQL専用4件は環境変数なしの通常runではskip                      |
| MySQL API integration                           | 4件成功。実CUID操作、所有権、並列上限、削除墓石、DB leaseを検証            |
| `pnpm build`                                    | API/Web/worker/sharedの4/4 build tasks成功                                 |
| `pnpm test:e2e`                                 | Chromium 1件成功                                                           |
| Fake `pnpm sync:scheduled`                      | 成功、targets=0 / failed=0                                                 |
| root `.env` startup                             | `apps/api` cwdからport 4319で起動し`GET /health`成功。一時`.env`は削除済み |
| 既存DB migration                                | 2 migration適用済み、`migrate status` up to date、schema diffなし          |
| 空DB migration                                  | 2 migrationを最初から適用成功、schema diffなし。検証専用DBは削除済み       |

回帰テストは通常43件、MySQL専用4件、E2E 1件の合計48件を成功確認した。Web/workerのVitestは既存設定どおり0件を許容するため、画面フローはE2E、worker入口はCLI smokeで補完した。

## 実資格情報を使うstaging確認

実装とモック契約は完了しているが、この作業環境にはSupabase/Google/YouTubeの実資格情報がない。公開前に次をstagingで行う。

1. Supabase staging userを作成し、Calendar作成済み状態から削除する。Calendar削除済み、refresh token失効済み、Auth user削除失敗/404を個別に作り、同じAPIの再実行で墓石がCOMPLETEDになることをDBで確認する。
2. staging Calendar eventと専用Calendarを手動削除して再同期する。未来eventだけが再作成され、過去/他User eventが残り、決定的IDの409再試行で重複しないことを確認する。
3. テスト用YouTubeチャンネルの開始前・配信中・終了済み・削除/非公開videoを同期し、実終了日時、Calendar PATCH、UNAVAILABLE、quota使用量を確認する。公式根拠がないpremiereはUNKNOWNのままになることも確認する。
4. OAuth consent/revokeを使い、invalid_grantでreauth停止、429/5xx相当の障害注入で一時失敗、再連携後のscheduled復帰を確認する。
5. API/workerを複数replicaで同じsubscriptionへ同時実行し、1件だけがleaseを取得すること、長時間実行時にleaseが延長されること、異常終了後に期限切れで復帰することを負荷試験する。

## 残存リスク

- 第三者チャンネルのプレミア公開を確実に識別できる公式fieldがないため、種別は安全側のUNKNOWNになる。これは誤判定を避ける仕様上の制約である。
- YouTube詳細応答からの欠落は削除・中止・権限変更を区別できないためUNAVAILABLEとして履歴とeventを保持する。
- 外部サービスの実レスポンス、quota、複数replica負荷は上記staging確認が必要である。Secret Manager、監視、backup、鍵ローテーションはdeploy環境側の運用作業として残る。
- Next.js buildには既存の「Next.js ESLint plugin未検出」警告が残るが、今回対象のCritical/Highではなくbuild/lintは成功している。

## 運用ルール

- 元の指摘は監査履歴として削除せず、[実装監査](./implementation-audit.md)の対応追記から本台帳へ参照する。
- errorCodeには安全な定数だけを保存し、OAuth/APIレスポンス全文やtokenを保存しない。
- DB変更は既存初期migrationを書き換えず、追加migrationだけで適用する。

## 独立再監査後の追補

本台帳の「修正済み」は当時の検証結果であり、独立再監査でAUDIT-001/006/008/009/011が部分解消、AUDIT-003/004に新規Highが見つかった。後続対応は[再監査修正台帳](./reaudit-remediation.md)で追跡し、削除HTTP timeoutとfencing、DB時刻lease、OAuth backoff/Retry-After、runIdログ、低entropy鍵拒否、過去event作成防止、YouTube quota unit予算を追加した。元の記録は監査証跡として保持する。
