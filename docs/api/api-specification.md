# REST API 仕様

OpenAPI の機械可読定義は [`openapi.yaml`](./openapi.yaml)。subscription IDはPrismaと同じCUIDとし、共有 `entityIdSchema` をHTTP path検証で使う。UUIDや不正形式は400、妥当だが存在しないCUIDと他User所有CUIDは404にする。

共通応答は成功時 `{ data, requestId }`、失敗時 `{ error: { code, message, details? }, requestId }`。内部例外、token、個人情報は返さない。

| Method | Path                                     | 認証 | 成功    | 用途                                 |
| ------ | ---------------------------------------- | ---- | ------- | ------------------------------------ |
| GET    | `/health`                                | 不要 | 200     | liveness                             |
| GET    | `/api/v1/me`                             | 必須 | 200     | 利用者・連携状態                     |
| POST   | `/api/v1/onboarding`                     | 必須 | 200/201 | provider token 保存・Calendar 作成   |
| GET    | `/api/v1/channels`                       | 必須 | 200     | 登録一覧                             |
| POST   | `/api/v1/channels/resolve`               | 必須 | 200     | handle 確認                          |
| POST   | `/api/v1/channels`                       | 必須 | 201     | 登録（409 重複、422 上限）           |
| PATCH  | `/api/v1/channels/{subscriptionId}`      | 必須 | 200     | pause/resume                         |
| DELETE | `/api/v1/channels/{subscriptionId}`      | 必須 | 204     | 未来 event 削除後に解除              |
| POST   | `/api/v1/channels/{subscriptionId}/sync` | 必須 | 202     | 手動同期（429 cooldown、409 実行中） |
| GET    | `/api/v1/sync-status`                    | 必須 | 200     | 最新結果                             |
| POST   | `/api/v1/google/reconnect`               | 必須 | 200     | provider token 更新                  |
| DELETE | `/api/v1/account`                        | 必須 | 204     | 確認文字付き・再開可能な段階削除     |

すべての所有資源操作は JWT `sub` と resource ID を同時条件にする。JSON 上限は 32 KiB。

通常APIは既存active Userだけを受け付ける。onboardingだけがローカルUserを作成でき、削除墓石があるsubjectは410を返す。削除APIは途中の外部障害を502で返すが進捗を保持し、同じJWTから再実行できる。同じsubjectの削除が実行中なら409を返す。完了後も墓石は残るため、旧JWTからUserを再作成しない。
