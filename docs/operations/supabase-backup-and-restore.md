# Supabase Free database backup / restore

## 契約

- GitHub Actions `Backup production database`が毎日02:15 JST頃にproduction Supabase Postgresの`app` schemaだけを`pg_dump --format custom`で取得する。
- dumpは公開しないS3 bucketへSSE-S3で保存し、bucket lifecycleで作成から7日後に削除する。
- Authを含むSupabase管理schemaはこのdumpの対象外である。Supabase Authの復旧はSupabase側のproject recoveryと別に扱う。
- backup jobはdirect接続またはSupavisor session mode用のmigration URLを使う。transaction poolerは使わない。
- Secret値、DB URL、dump内容をActions log、artifact、Gitへ出さない。
- Free projectは低activity時にpauseされ得る。backup成功をavailability保証やpause回避策として扱わない。

## 日次確認

1. Actions jobがsuccessであることを確認する。
2. jobが出力するobject sizeと`AES256`だけを確認する。object keyに利用者情報を含めない。
3. S3 lifecycleが7日であり、8日以上前のobjectが残っていないことを月次確認する。
4. 失敗時はSNS/運用通知から24時間以内に再取得する。失敗したdumpをsuccess扱いにしない。

## Restore rehearsal

restoreは既存production DBへ直接上書きしない。

1. 復旧専用の空PostgreSQL database/projectと、一時的なmigration owner credentialを用意する。
2. 対象objectをS3から安全な一時directoryへ取得し、`pg_restore --list`が成功することを確認する。
3. 空の`app` schemaへ次を実行する。

   ```bash
   pg_restore --dbname "$RECOVERY_DATABASE_URL" --schema app --no-owner --no-privileges backup.dump
   ```

4. migration status、table件数、foreign key、unique index、SyncLease/quotaの整合を確認する。credential暗号文や個人情報は表示しない。
5. アプリをread-only確認先へ接続して`/ready`と匿名化した主要件数を確認する。
6. 復旧先をproductionへ昇格する場合は、OAuth/Calendar/Syncを停止したmaintenance windowと別承認を必要とする。DNSやSecretを自動的に切り替えない。
7. rehearsal用DB、credential、local dumpは別承認で削除し、結果と実RPOだけを記録する。

## Recovery point

成功した直近日次dumpが復旧点であり、設計上の最大RPOは24時間である。S3 objectを7日保持するため、最大7世代から選択できる。PITRは提供しない。
