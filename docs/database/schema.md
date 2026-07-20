# データベース設計

Prisma の実体は [`prisma/schema.prisma`](../../prisma/schema.prisma) を正とする。

| モデル                  | 用途                                | 主な一意制約・索引                               |
| ----------------------- | ----------------------------------- | ------------------------------------------------ |
| User                    | Supabase 主体、初回設定・再認証状態 | `supabaseUserId`, email index                    |
| GoogleCredential        | 暗号化 refresh token                | `userId`, keyId                                  |
| CalendarConnection      | 専用 calendar ID・状態              | `userId`, `googleCalendarId`                     |
| YouTubeChannel          | 利用者間で共有するチャンネル        | `youtubeChannelId`, handle index                 |
| UserChannelSubscription | 利用者別の有効/停止状態             | `(userId,channelId)`, user/status index          |
| ScheduledBroadcast      | 共有する配信履歴                    | `youtubeVideoId`, `(channelId,scheduledStartAt)` |
| CalendarEventMapping    | 利用者別 Calendar event             | `(userId,broadcastId)`, event ID index           |
| SyncRun                 | 同期実行全体                        | type/status/start index                          |
| SyncTargetResult        | 対象別結果・表示用最新日時          | `(syncRunId,targetType,targetId)`                |
| AccountDeletionRequest  | 再実行可能な削除状態                | `userId`, status index                           |

外部参照先の共有 Channel/Broadcast は subscription 削除時に cascade しない。ユーザー固有の credential/connection/mapping/subscription は User 削除で cascade する。履歴 Broadcast は物理保持し、将来 retention job を追加する。全 DateTime は MySQL `DATETIME(3)` で UTC として扱う。
