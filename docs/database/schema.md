# データベース設計

Prisma の実体は [`prisma/schema.prisma`](../../prisma/schema.prisma) を正とする。

| モデル                  | 用途                                | 主な一意制約・索引                                |
| ----------------------- | ----------------------------------- | ------------------------------------------------- |
| User                    | Supabase 主体、初回設定・再認証状態 | `supabaseUserId`, email index                     |
| GoogleCredential        | 暗号化 refresh token                | `userId`, keyId                                   |
| CalendarConnection      | 専用 calendar ID・状態              | `userId`, `googleCalendarId`                      |
| YouTubeChannel          | 利用者間で共有するチャンネル        | `youtubeChannelId`, handle index                  |
| UserChannelSubscription | 利用者別の有効/停止状態             | `(userId,channelId)`, user/status index           |
| ScheduledBroadcast      | 共有する配信履歴                    | `youtubeVideoId`, `(channelId,scheduledStartAt)`  |
| CalendarEventMapping    | 利用者別 Calendar event             | `(userId,broadcastId)`, event ID index            |
| SyncRun                 | 同期実行全体                        | type/status/start index                           |
| SyncTargetResult        | 対象別結果・表示用最新日時          | `(syncRunId,targetType,targetId)`                 |
| AccountDeletionRequest  | User削除後も残る再実行可能な墓石    | `supabaseUserId`, nullable `userId`, status index |
| SyncLease               | API/worker間の同期排他lease         | key, expiresAt index                              |

外部参照先の共有 Channel/Broadcast は subscription 削除時に cascade しない。ユーザー固有の credential/connection/mapping/subscription は User 削除で cascade する。AccountDeletionRequest は Supabase subject を一意キーとして保持し、User FK は `SET NULL` のためローカル削除後も残る。各外部削除stepの完了時刻により再開位置を決める。

BroadcastKind は `LIVE/PREMIERE/UNKNOWN`、BroadcastStatus は `UPCOMING/LIVE/COMPLETED/CANCELLED/UNAVAILABLE`（旧互換の `UNKNOWN` を含む）を表現する。APIだけで確定できない種別・欠落を推測で確定しない。SyncLease はowner tokenと期限を持ち、期限内の同じkeyを一意制約で拒否し、処理中に同じownerだけが延長できる。

SyncRun/SyncTargetResult は開始時にRUNNINGを保存し、正常・部分失敗・全失敗を完了時刻と安全なerror codeで確定する。定期同期の開始時に24時間超のRUNNINGをFAILEDへ回収し、完了から90日を過ぎた実行履歴を削除する。Broadcast履歴はこのretentionの対象にしない。

履歴 Broadcast は物理保持し、将来 retention job を追加する。全 DateTime は MySQL `DATETIME(3)` で UTC として扱う。3件上限の作成はUser行を `FOR UPDATE` したserializable transaction内でcountとinsertを行い、重複は `(userId,channelId)` 制約でも防ぐ。
