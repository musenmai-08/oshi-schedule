# 初回staging rollout

初回full stackはDB migrationより先にAPIやtargeted Workerを起動しない。`deployReady`はfull resource作成許可、`applicationActivated`はmigration完了後のapplication起動許可であり、責務が異なる。

## 共通contextのsource of truth

staging full deployで使う共通contextは[`infra/config/staging-deploy.json`](../../infra/config/staging-deploy.json)を唯一のrepository-managed source of truthとする。account/region、domain/certificate、検証済みimage digest、4つのapplication Secretのcomplete ARN、Budget、GitHub、CPU/memory、RDS、`workerScheduleEnabled=false`をここで管理する。CloudFormationの実値から毎回逆生成しない。Secret ARNは識別子であり、Secret値はこのファイルへ保存しない。

通知先とSupabase公開設定は環境固有入力であり、repositoryへ実値をcommitしない。ローカルではGit管理外のroot `.env`へ次を設定する。

```dotenv
STAGING_ALERT_EMAIL=<notification-email>
NEXT_PUBLIC_SUPABASE_URL=<staging-supabase-url>
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable-key>
```

`STAGING_ALERT_EMAIL`がなければ`ALLOWED_EMAILS`の先頭を通知先として使用する。曖昧さを避けるため、継続運用では明示設定を推奨する。GitHub Actionsで将来このpresetを使う場合は、GitHub Environment `staging`から次のように同じ環境変数を注入する。

| 環境変数                               | GitHubでの保管先                     |
| -------------------------------------- | ------------------------------------ |
| `STAGING_ALERT_EMAIL`                  | Environment Secret（個人情報を保護） |
| `NEXT_PUBLIC_SUPABASE_URL`             | Environment Variable                 |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Environment Variable                 |

Deploy staging gateは既存どおりdisabledのままとし、この変更ではworkflowを有効化しない。Secret key、service role key、OAuth secret、tokenはCDK contextへ渡さない。

Amplify server-side callbackが使用する`WEB_ORIGIN`は、repository-managedな`webDomainName`からCDKがHTTPS originとして生成する。stagingでは`https://staging.oshi-schedule.com`であり、外部入力やSecretとして重複管理しない。

入力をマスク表示し、Phase間で共通fingerprintが同じことを確認できる。

```bash
pnpm staging:context:show -- phase1
pnpm staging:context:show -- phase2
pnpm staging:cdk:phase1 -- --dry-run
pnpm staging:cdk:phase2 -- --dry-run
```

通知先とPublishable keyは常に`<masked>`表示される。fingerprintはrepository-managed共通contextだけから生成し、個人情報や外部入力を含まない。

## 安全context preset

repository rootのpresetは上記共通contextを読み込み、3つのphase contextだけを追加する。`-c`/`--context`、別app、別profileの追加指定を拒否し、phase固有値や共通値の上書きを防ぐ。

| Phase | `apiDesiredCount` | `syncPipeDesiredState` | `applicationActivated` |
| ----- | ----------------- | ---------------------- | ---------------------- |
| 1     | `0`               | `STOPPED`              | `false`                |
| 2     | `1`               | `RUNNING`              | `true`                 |

```bash
AWS_PROFILE=oshi-schedule pnpm staging:cdk:phase1 -- synth
AWS_PROFILE=oshi-schedule pnpm staging:cdk:phase1 -- diff
AWS_PROFILE=oshi-schedule pnpm staging:cdk:phase1 -- deploy

AWS_PROFILE=oshi-schedule pnpm staging:cdk:phase2 -- synth
AWS_PROFILE=oshi-schedule pnpm staging:cdk:phase2 -- diff
AWS_PROFILE=oshi-schedule pnpm staging:cdk:phase2 -- deploy
```

操作を省略した`pnpm staging:cdk:phase1`と`pnpm staging:cdk:phase2`は安全な既定として`synth`を実行する。Phase 1/2で変更するのはpreset管理の3項目だけである。手動contextを追加せず、diff承認なしにdeployしない。image更新時はscan済みECR digestを確認し、`infra/config/staging-deploy.json`の`imageTag`だけを新しい`sha256:...`へ更新して、Phase 1/2のfingerprintとsynth差分を再確認する。

外部管理のSecrets Manager Secretは、`DescribeSecret`で確認した6文字suffix付きcomplete ARNを共通contextへ設定し、`fromSecretCompleteArn`でimportする。Secret名またはsuffixなしpartial ARNからECS Task Definitionの`ValueFrom`を生成してはならない。parserはaccount、region、期待するSecret名、6文字suffixをsynth前に検証する。API/WorkerのExecution Roleに付く`secretsmanager:GetSecretValue`のResourceは同じcomplete ARNへ限定し、Task RoleへSecret読取権限を付けない。Task Definitionの`ValueFrom`とExecution RoleのResourceが一致する契約は回帰テストで保証する。productionはproduction固有のcomplete ARNを明示し、staging ARNを流用しない。

## Phase 1: infrastructure

Phase 1 templateをsynthし、API `DesiredCount=0`、Pipe `DesiredState=STOPPED`、`/oshi-schedule-staging/runtime/application-activated=false`、Worker Scheduler `DISABLED`を確認してからdeployする。RDS、HTTP API、VPC Link、Cloud Map、SQS、task definitionsなどは作成されるがapplication処理は開始しない。

ECRへpushするruntime imageは、build中に`pnpm deploy`後のproduction node_modulesへ正式schemaからPrisma Clientを生成する。`scripts/validate-runtime-image.sh`でruntime userによる`@prisma/client`の実import、data model、`PrismaClient`構築、API/Worker import、migration CLI/schemaを確認し、すべて成功するまでdigestを共通contextへ設定しない。`.prisma/client`のfile存在だけでは未生成stubを区別できないため不十分である。

Secret参照修正などTask Definition revisionだけを更新するremediationでは、まずPhase 1のままdiff/deployし、API 0、Pipe `STOPPED`、activation `false`を維持する。Task DefinitionとExecution Roleの整合を確認した後に、別途明示承認したPhase 2でapplicationを起動する。

`wake-expires-at=UNSET`ではauto-sleep Lambdaはno-opなのでmigration中にRDSを停止しない。Phase 1中の`pnpm staging:status`は`Application activation: NOT_READY`、`API: NOT_STARTED`を表示する。`pnpm staging:wake`はactivation Parameterをreadした後、期限、RDS、ECSへのwrite前に拒否する。

Phase 1より前にqueueへmessageが存在してもPipeが`STOPPED`なのでtargeted Workerは起動しない。HTTP API/domainへrequestが来た場合はbackend不在で5xxになり得るため、この期間はAmplify GitHub Appを接続せずWebを公開しない。

SNS subscription確認メールはPhase 1で送られてよい。購読承認はPhase 1後またはPhase 2後に行い、rollout完了までに済ませる。

## Phase 1.5: migration

CDK outputのMigration Task Definition、cluster、public subnet、Worker security groupを照合し、digest固定済みのone-off Migration Taskを1つだけ実行する。Migration taskはRDS credentialとDB network accessだけを使い、application Secretを受け取らない。

次をすべて満たすまでPhase 2へ進まない。

- taskが停止し、migration containerの`exitCode=0`
- 同じschema/imageを使う一回限りの確認で`prisma migrate status`がpending migrationなし
- 承認済みのschema drift確認が差分なし
- migration logにcredential、DB URL、個人情報がない

migrationが失敗または確認不能ならAPI 0、Pipe `STOPPED`、activation `false`を維持し、Phase 2 deploy、`staging:wake`、Amplify接続を行わない。DBをreset/down migrationせず、原因を調査してforward-fixする。

## Phase 2: application activation

同じ共通contextとimage digestにPhase 2 presetを適用する。Phase 1とPhase 2の共通fingerprintが一致することを先に確認する。diffではECS Service、EventBridge Pipe、activation SSM Parameterだけがupdate-in-placeであり、replace/deleteがないことを確認してからdeployする。

deploy後に次を確認する。

1. API desired count 1、service stable、Cloud MapへAPI taskが1件以上登録
2. Pipe `RUNNING`、Worker Scheduler `DISABLED`
3. VPC Link `AVAILABLE`、HTTP API正常
4. `https://api-staging.oshi-schedule.com/health`と`/ready`が2xx
5. `pnpm staging:status`が`Application activation: READY`

Pipe開始後、Phase 1中にqueueへ保持されたmessageは通常のSQS/Pipe契約に従ってtargeted Workerへ渡される。DLQ、SyncRun、Worker logを確認し、重複手動再送を避ける。

API確認後に限りAmplify GitHub Appを接続し、`main`の初回build、OAuth smoke、承認済みcontrolled async sync、SNS/alarm確認を行う。終了後は`pnpm staging:sleep`で低コスト状態へ移行する。`staging:wake`はactivationが`READY`になった後だけ利用でき、Worker Schedulerを有効化しない。

## production

production通常値はAPI 1、Pipe `RUNNING`、activation `true`である。将来migrationを伴う初回構築・保守では同じPhase 1 false/0/STOPPED、migration、Phase 2 true/1/RUNNINGを利用できる。production acknowledgement、snapshot、Environment approvalなど既存gateは省略しない。
