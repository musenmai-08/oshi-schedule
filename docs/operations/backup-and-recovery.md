# バックアップ・障害復旧

## 運用契約

productionはSupabase FreeのPostgreSQLを使用する。Supabase Freeの自動バックアップやPITRを前提にせず、GitHub Actionsの`backup-production.yml`が毎日`app` schemaだけをPostgreSQL 17のcustom-format dumpとして取得し、privateなS3 bucketへ暗号化して保存する。S3 lifecycleは7日後の自動削除をIaCで強制する。

| 対象 | RPO目標 | RTO目標 | 保持 |
| --- | --- | --- | --- |
| application `app` schema | 最大24時間 | 次の営業日 | S3 7日 |
| Supabase Auth | Supabase Freeの提供条件に従う | best effort | 独自dump対象外 |

これはSLAではない。一般公開後に24時間のRPO、Free projectのpause、または復旧時間が許容できなくなった場合は、Supabase Pro/PITRまたは別の継続バックアップを先に設計する。

## 作成と監視

- workflowはGitHub Environment `production-backup`のOIDC roleだけを使用し、migration用DB URL Secretを一時的にmemoryへ取得する。値をartifact、command line、logへ残さない。
- `postgres:17-alpine`で`pg_dump --schema app --format custom --no-owner --no-privileges`を実行し、`pg_restore --list`成功後だけuploadする。
- bucketはBlock Public Access、TLS必須、SSE-S3、7日expiration、`RETAIN`である。stack削除をデータ削除とみなさない。
- backup failure、24時間以上の成功空白、空または異常に小さいobjectはincidentとして扱う。成功通知だけで復元可能性を推測しない。
- backup jobはFree projectのpause回避を目的にしない。pauseを検知した場合は運営者がSupabase Dashboardで復旧し、backupを再実行する。

## 復元手順

詳細なコマンドと安全条件は[Supabase backup/restore runbook](supabase-backup-and-restore.md)を正とする。

1. Worker SchedulerとSQS event sourceを停止し、APIをmaintenance扱いにしてwriteを止める。
2. 復元対象object、取得時刻、size、encryptionを確認する。元DBを上書きしない。
3. 隔離した新しいPostgreSQL database/projectへ`pg_restore`する。
4. migration status、主要table件数、foreign key、unique constraint、timestamp、credential ciphertext/key IDを非機密summaryで検証する。token本文を表示しない。
5. 新runtime DB secretを切り替え、`/health`と`/ready`、read-only smokeを確認してからtrafficを切り替える。
6. Workerをcontrolled runし、SQS/DLQ、Calendar差分、YouTube quota、deterministic event IDを確認してSchedulerを戻す。
7. RPO内の欠損、Google Calendarとの不整合、Supabase Authとapp Userの対応を評価する。

## 障害別の判断

| シナリオ | 対応 |
| --- | --- |
| 誤migration / app data破損 | deploy停止。forward fixできなければ新DBへ直前dumpをrestoreし、DB URLを切替 |
| Supabase project pause | Dashboardで復旧後、`/ready`とbackup空白を確認。自動的な有料化はしない |
| Worker重複 / 途中終了 | lease expiry後に再実行。fencing、atomic claim、deterministic Calendar IDを維持 |
| Google credential失効 | `reauthRequired`を設定し再同意を案内。backupからtokenを手作業で抽出しない |
| SQS/DLQ滞留 | Schedulerを停止し、error分類とSyncRunを確認してから1件ずつ回収 |
| encryption key喪失 | token復号不能。Google再同意が必要。key materialをrepoやbackup objectへ同梱しない |

## 復元演習

四半期ごとに最新dumpを隔離DBへ復元し、所要時間、対象migration、件数整合、暗号形式、欠損を記録する。元Supabase project、Google Calendar、SQSにはwriteしない。演習後のisolated DB削除は別承認とする。
