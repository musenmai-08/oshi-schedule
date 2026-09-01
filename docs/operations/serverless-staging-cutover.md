# serverless staging cutover

このrunbookは既存MySQL/ECS stagingからSupabase Postgres/Lambda stagingへ一度だけ移す手順である。各AWS/Supabase write、実migration、ETL、deployは別途承認する。既存stagingを先に削除・上書きしない。

## 事前条件

- staging専用Supabase project、Google credential、application Secretをproductionと共有しない。
- Supabaseに非公開`app` schemaを作成できるmigration ownerと、DMLだけのruntime LOGIN roleを分離する。
- runtime URLはSupavisor transaction mode、TLS、`pgbouncer=true`、`connection_limit=1`を含む。migration URLはdirect IPv6またはSupavisor session modeで、transaction poolerを使わない。
- GitHub `staging` Environmentにserverless CDK context、deploy role、migration Secret ARNを設定する。Scheduler初期状態は`DISABLED`にする。
- 旧RDS/ECS/Pipeはsleep/disabledのままrollback期間中保持する。削除は別承認とする。

## DB準備

1. protected terminalからmigration URLを取得し、値を表示せず`prisma migrate deploy`と`migrate status`を実行する。
2. passwordをGitやshell historyへ残さずruntime LOGIN roleを作成する。
3. `psql "$DIRECT_URL" --set=runtime_role=<role> --file prisma/runtime-role.sql`でDMLだけをgrantする。
4. runtime URLでmigration/DDL、`auth`/`storage`/`public` schema、role変更が拒否され、`app` tableの必要なDMLだけが成功することを確認する。
5. 既存staging dataを移す場合は専用ETLを別reviewする。ID、FK、timestamp、ciphertext/key ID、件数だけを比較し、tokenやメールを出力しない。dual-writeは行わない。

## IaC cutover

1. `serverless-deploy.mjs diff staging`でLambda API/Worker、HTTP API、SQS/DLQ、Scheduler、DynamoDB、S3 backup、Amplifyだけが差分であることを確認する。
2. RDS/ECS/VPC/VPC Link/Cloud Map/Pipe/Public IPv4の新規作成が0であること、既存旧resourceのDELETE/REPLACEが0であることを確認する。
3. deploy後、Schedulerは`DISABLED`のまま、API `/health`/`ready`、API/Workerのreserved concurrencyが未設定、SQS event sourceのbatch size `1`・maximum concurrency `2`、Secret exact ARN、log retentionを確認する。Scheduler有効時はWorkerを直接invokeせず、`{kind:"scheduled"}` messageをsync queueへ送ることを確認する。
4. OAuth、manual sync、duplicate delivery、Calendar CRUD、account deletion、14分以内のscheduled syncを順に受入する。
5. 日次backupを手動dispatchし、S3 object、暗号化、restore list、7日lifecycleを確認する。Supabase Authがdump対象外であることも記録する。

## rollback

cutover前またはdata write前はdeployを中止する。cutover後はScheduler/event sourceを停止し、Amplify/API originを旧stagingへ戻す。PostgreSQL dataをMySQLへ自動逆変換しない。旧RDS/ECSは受入完了後30日間sleep/disabledで保持し、削除はresource別承認にする。

### 初回preview rollback後の再作成

staging previewのempty backup bucketはrollback時に`DELETE`となるようtemplateを設定する。productionのbucketだけは`RETAIN`する。既に`ROLLBACK_COMPLETE`で`DELETE_SKIPPED`となったnamed bucketは、削除禁止のため自動createでは再利用しない。再deploy前に次を別承認のwriteとして行う。

1. bucketが空、SSE-S3、public access block、7日lifecycleであることをread-only確認する。
2. `ROLLBACK_COMPLETE` stackを削除する。この操作はretained bucketを削除しない。
3. `DatabaseBackupBucket`のresource import change setで同じphysical bucketを新stackへimportし、import後のdiffが0であることを確認する。
4. import成功後だけpreview deployを再開する。import失敗時はbucketを削除・名前変更せず停止する。

## hard blockers

- PostgreSQL migrationを実DBへ未適用
- runtime/migrator role分離とData API deny未検証
- 既存MySQL staging data ETLの要否未決定
- Lambda scheduled runの実測が14分未満か未確認
- S3 dumpのrestore rehearsal未完了
