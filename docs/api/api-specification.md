# REST API 仕様

OpenAPI の機械可読定義は [`openapi.yaml`](./openapi.yaml)。共有 Zod schema を HTTP 実装とテストで利用し、CI で OpenAPI endpoint と status のスモーク検査を行う。

共通応答は成功時 `{ data, requestId }`、失敗時 `{ error: { code, message, details? }, requestId }`。内部例外、token、個人情報は返さない。

| Method | Path                         | 認証 | 成功    | 用途                                 |
| ------ | ---------------------------- | ---- | ------- | ------------------------------------ |
| GET    | `/health`                    | 不要 | 200     | liveness                             |
| GET    | `/api/v1/me`                 | 必須 | 200     | 利用者・連携状態                     |
| POST   | `/api/v1/onboarding`         | 必須 | 200/201 | provider token 保存・Calendar 作成   |
| GET    | `/api/v1/channels`           | 必須 | 200     | 登録一覧                             |
| POST   | `/api/v1/channels/resolve`   | 必須 | 200     | handle 確認                          |
| POST   | `/api/v1/channels`           | 必須 | 201     | 登録（409 重複、422 上限）           |
| PATCH  | `/api/v1/channels/{id}`      | 必須 | 200     | pause/resume                         |
| DELETE | `/api/v1/channels/{id}`      | 必須 | 204     | 未来 event 削除後に解除              |
| POST   | `/api/v1/channels/{id}/sync` | 必須 | 202     | 手動同期（429 cooldown、409 実行中） |
| GET    | `/api/v1/sync-status`        | 必須 | 200     | 最新結果                             |
| POST   | `/api/v1/google/reconnect`   | 必須 | 200     | provider token 更新                  |
| DELETE | `/api/v1/account`            | 必須 | 202/204 | 確認文字付き削除                     |

すべての所有資源操作は JWT `sub` と resource ID を同時条件にする。JSON 上限は 32 KiB。
