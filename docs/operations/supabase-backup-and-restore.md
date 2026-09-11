# Supabase Free database backup / restore

## 契約

- GitHub Actions `Backup production database`が毎日02:15 JST頃にproduction Supabase Postgresの`app` schemaだけを`pg_dump --format custom`で取得する。
- dumpは公開しないS3 bucketへSSE-S3で保存し、bucket lifecycleで作成から7日後に削除する。
- Authを含むSupabase管理schemaはこのdumpの対象外である。Supabase Authの復旧はSupabase側のproject recoveryと別に扱う。
- backup jobはdirect接続またはSupavisor session mode用のmigration URLを使う。transaction poolerは使わない。
- Secret値、DB URL、dump内容をActions log、artifact、Gitへ出さない。
- 各`app-<timestamp>.dump`には同じprefixの`app-<timestamp>.migrations.json`を必ず対応させる。manifestはbackup時のGit commitと、`app._prisma_migrations`で完了済み・未rollbackのmigration ID/checksumを保持する。DBの状態がそのcommitのGit migration列の正しいprefixであり、各`migration.sql`のSHA-256と一致した場合だけ作成する（mainに未適用の次migrationがあってもbackupは可能）。dump単体を復元可能backupとして扱わない。
- Free projectは低activity時にpauseされ得る。backup成功をavailability保証やpause回避策として扱わない。

### Staging serverless

- `Backup staging serverless database` workflowはGitHub Environment `staging-backup`に限定したOIDC roleで、staging migration owner URLを一時的に使い、同じ`app` schema custom dumpを既存のstaging preview backup bucketへ保存する。production workflow、role、bucketは参照しない。
- workflow roleはdump objectのuploadと検証読み取りだけを許可する。削除はS3 lifecycle（7日）だけが実行する。
- stagingの実行後はobjectのサイズと`AES256`、public access block、7日Lifecycleを確認する。URL、dump本文、credentialを出力しない。

## 日次確認

1. Actions jobがsuccessであることを確認する。
2. jobが出力するobject sizeと`AES256`だけを確認する。object keyに利用者情報を含めない。
3. S3 lifecycleが7日であり、8日以上前のobjectが残っていないことを月次確認する。
4. 失敗時はSNS/運用通知から24時間以内に再取得する。失敗したdumpをsuccess扱いにしない。

## Restore rehearsal

restoreは既存production DBへ直接上書きしない。

1. 復旧専用の空PostgreSQL database/projectと、一時的なmigration owner credentialを用意する。
2. 対応するdumpと`.migrations.json`をS3から安全な一時directoryへ取得する。`node scripts/database/migration-state.mjs verify unused.csv migrations.json <release-commit>`で、release commitとGit上のmigration ID/checksumが完全一致すること、および`pg_restore --list`が成功することを確認する。
3. 空のrehearsal DBで`app` schemaを明示的に作成してから、次を実行する。`pg_dump --schema app`のcustom dumpにはschema自体の作成DDLが含まれないため、これを省略しない。

   ```bash
   psql "$RECOVERY_DATABASE_URL" --set ON_ERROR_STOP=1 --command 'CREATE SCHEMA app'
   pg_restore --dbname "$RECOVERY_DATABASE_URL" --schema app --no-owner --no-privileges backup.dump
   ```

4. 一時DBの`app._prisma_migrations`から完了済み・未rollbackの`migration_name,checksum`だけをCSV取得し、`node scripts/database/migration-state.mjs verify-restored state.csv migrations.json <release-commit>`を実行する。manifest・復元DB・release commitの3者が一致しなければ復旧先へ昇格しない。その後table件数、foreign key、unique index、SyncLease/quotaの整合を確認する。credential暗号文や個人情報は表示しない。
5. アプリをread-only確認先へ接続して`/ready`と匿名化した主要件数を確認する。
6. 復旧先をproductionへ昇格する場合は、OAuth/Calendar/Syncを停止したmaintenance windowと別承認を必要とする。DNSやSecretを自動的に切り替えない。
7. rehearsal用DB、credential、local dumpは別承認で削除し、結果と実RPOだけを記録する。

## Recovery point

成功した直近日次dumpが復旧点であり、設計上の最大RPOは24時間である。S3 objectを7日保持するため、最大7世代から選択できる。PITRは提供しない。
