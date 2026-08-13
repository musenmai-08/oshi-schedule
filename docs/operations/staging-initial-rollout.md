# 初回staging rollout

初回full stackはDB migrationより先にAPIやtargeted Workerを起動しない。`deployReady`はfull resource作成許可、`applicationActivated`はmigration完了後のapplication起動許可であり、責務が異なる。

## 安全context preset

repository rootのpresetは3つの安全contextを一括指定し、同名contextの追加指定を拒否する。

| Phase | `apiDesiredCount` | `syncPipeDesiredState` | `applicationActivated` |
| ----- | ----------------- | ---------------------- | ---------------------- |
| 1     | `0`               | `STOPPED`              | `false`                |
| 2     | `1`               | `RUNNING`              | `true`                 |

```bash
AWS_PROFILE=oshi-schedule pnpm staging:cdk:phase1 -- diff <共通context>
AWS_PROFILE=oshi-schedule pnpm staging:cdk:phase1 -- deploy <共通context>

AWS_PROFILE=oshi-schedule pnpm staging:cdk:phase2 -- diff <同じ共通context>
AWS_PROFILE=oshi-schedule pnpm staging:cdk:phase2 -- deploy <同じ共通context>
```

`<共通context>`には`environment=staging`、account/region、`deployReady=true`、`bootstrapOnly=false`、domain/certificate、image digest、Budget 25、GitHub、公開Supabase値、CPU/memory、RDS、`workerScheduleEnabled=false`を指定する。Secret値はcontextへ渡さない。Phase 1/2で変更するのはpreset管理の3項目だけである。diff承認なしにdeployしない。

## Phase 1: infrastructure

Phase 1 templateをsynthし、API `DesiredCount=0`、Pipe `DesiredState=STOPPED`、`/oshi-schedule-staging/runtime/application-activated=false`、Worker Scheduler `DISABLED`を確認してからdeployする。RDS、HTTP API、VPC Link、Cloud Map、SQS、task definitionsなどは作成されるがapplication処理は開始しない。

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

同じ共通contextとimage digestにPhase 2 presetを適用する。diffではECS Service、EventBridge Pipe、activation SSM Parameterだけがupdate-in-placeであり、replace/deleteがないことを確認してからdeployする。

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
