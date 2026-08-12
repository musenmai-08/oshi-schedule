# REST API 仕様

OpenAPI の機械可読定義は [`openapi.yaml`](./openapi.yaml)。subscription IDはPrismaと同じCUIDとし、共有 `entityIdSchema` をHTTP path検証で使う。UUIDや不正形式は400、妥当だが存在しないCUIDと他User所有CUIDは404にする。

共通応答は成功時 `{ data, requestId }`、失敗時 `{ error: { code, message, details? }, requestId }`。内部例外、token、個人情報は返さない。

| Method | Path                                     | 認証 | 成功    | 用途                                                     |
| ------ | ---------------------------------------- | ---- | ------- | -------------------------------------------------------- |
| GET    | `/health`                                | 不要 | 200     | liveness・`service=oshi-schedule-api`識別                |
| GET    | `/ready`                                 | 不要 | 200/503 | 必須設定検証済みprocessのDB readiness。外部APIは呼ばない |
| GET    | `/api/v1/me`                             | 必須 | 200     | 利用者・連携状態                                         |
| POST   | `/api/v1/onboarding`                     | 必須 | 200/201 | provider token 保存・Calendar 作成                       |
| GET    | `/api/v1/channels`                       | 必須 | 200     | 登録一覧                                                 |
| POST   | `/api/v1/channels/resolve`               | 必須 | 200     | handle 確認                                              |
| POST   | `/api/v1/channels`                       | 必須 | 201     | 登録確定と初回同期job受付（409 重複、422 上限）          |
| PATCH  | `/api/v1/channels/{subscriptionId}`      | 必須 | 200     | pause/resume                                             |
| DELETE | `/api/v1/channels/{subscriptionId}`      | 必須 | 204     | 未来 event 削除後に解除                                  |
| POST   | `/api/v1/channels/{subscriptionId}/sync` | 必須 | 202     | 手動同期job受付（active jobは同じID、429 cooldown）      |
| GET    | `/api/v1/sync-runs/{syncRunId}`          | 必須 | 200     | 所有する初回・手動同期jobの状態と結果                    |
| GET    | `/api/v1/sync-status`                    | 必須 | 200     | 最新結果                                                 |
| POST   | `/api/v1/google/reconnect`               | 必須 | 200     | provider token 更新                                      |
| DELETE | `/api/v1/account`                        | 必須 | 204     | 確認文字付き・再開可能な段階削除                         |

すべての所有資源操作は JWT `sub` と resource ID を同時条件にする。JSON 上限は 32 KiB。

`/health`はprocess livenessだけを返し、DB障害時も200を維持する。ECS container health checkはNode.jsからlocalhostの`/health`を確認する。`/ready`はPrismaから`SELECT 1`だけを実行し、DB接続不能時は503を返す。いずれも認証不要で、設定値、DB endpoint、例外詳細、外部Google/YouTube応答を返さない。

通常APIは既存active Userだけを受け付ける。onboardingだけがローカルUserを作成でき、削除墓石があるsubjectは410を返す。削除APIは途中の外部障害を502で返すが進捗を保持し、同じJWTから再実行できる。同じsubjectの削除が実行中なら409を返す。完了後も墓石は残るため、旧JWTからUserを再作成しない。

同期要求と外部同期実行は分離する。`POST /channels`は201でsubscriptionと`sync: { id, subscriptionId, status }`、手動同期は202で同じjob識別情報を即時返す。YouTube/Google CalendarはHTTP応答条件ではなく、SQSから起動したtargeted workerが処理するためAPI Gatewayの30秒上限に依存しない。同じsubscriptionに`QUEUED`/`RUNNING`があれば新しいrunを作らず既存runを返す。

clientは`GET /sync-runs/{id}`をpollし、`QUEUED`、`RUNNING`、`SUCCESS`、`FAILED`、`DEFERRED`を区別する。応答にはqueued/started/finished時刻、安全なerror summary、YouTube取得・DB更新・Calendar同期のphaseとsnapshot versionを含む。他Userのrunは404とする。handle解決時にquota不足ならCalendar同期対象がないため429 `YOUTUBE_QUOTA_DEFERRED` を返す。

JSON本文は32 KiBまでとし、JSON構文不正・必須本文なしは400、上限超過は413で共通エラーJSONを返す。未定義ルートもHTMLではなく404の共通JSONとする。通常の400/401/403/404はinfo、競合・rate limit等はwarn、500系はerrorへ分類し、本文・stack・内部例外・秘密値を応答やログへ含めない。

`POST /api/v1/channels`はSubscriptionと`INITIAL` SyncRunをDB確定後、SQSへrun IDだけを送る。dispatch失敗でも登録はロールバックせず201とし、syncを`FAILED`、error codeを`SYNC_DISPATCH_FAILED`として記録する。手動dispatch失敗は503とし、新しい要求で再試行できる。初回同期は手動同期の5分クールダウンを開始しない。
