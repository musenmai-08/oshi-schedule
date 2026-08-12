# staging低コスト運用

## 目的と適用範囲

このrunbookは`oshi-schedule-staging`だけを対象にする。VPC、ECR、HTTP API、VPC Link、Cloud Map、SQS/Pipes、Route 53、ACM、Secrets Manager、RDS storageは維持し、未使用時にECS API computeとRDS DB instance computeを止める。productionには適用しない。

コマンドはAWS account `741448960817`、region `ap-northeast-1`、profile `oshi-schedule`、environment `staging`を固定guardとして検証する。`default` profileへfallbackせず、CloudFormation stackのOutputsだけから操作対象を解決する。Secretの取得・表示、resourceの削除、snapshot、rebootは行わない。

## 通常の操作

利用開始：

```bash
pnpm staging:wake
# 現在時刻から4時間利用

pnpm staging:wake --hours 8
# 現在時刻から8時間利用（1〜24の整数）
```

状態確認：

```bash
pnpm staging:status
```

利用終了：

```bash
pnpm staging:sleep
```

`wake`は実行時刻を基準にUTCの利用期限を`/oshi-schedule-staging/runtime/wake-expires-at`へ保存する。すでに起動中でも再実行でき、その時点から指定時間へ期限を延長する。`--hours`省略時は4時間、上限は24時間で、0、負数、25以上、小数、文字列はAWS write前に拒否する。

通常の終了操作は引き続き`staging:sleep`である。自動sleepは停止忘れに対するsafety netであり、利用終了まで待つための通常手段ではない。manual sleepは期限を削除せず現在時刻へ更新してexpired状態にする。

通常の休止状態は次のとおり。

```text
ECS API desiredCount = 0
RDS = stopped
Worker Scheduler = DISABLED
```

検証中は次の状態を標準とする。

```text
ECS API desiredCount = 1
RDS = available
Worker Scheduler = DISABLED
```

Worker Schedulerは`staging:wake`で有効化しない。YouTube quotaとFargate費用を使う同期検証は、別の承認済み操作でSchedulerを明示的に有効化する。

## statusの判定

`staging:status`は読み取り専用でCloudFormation、HTTP API、VPC Link、Cloud Map、sync queue/Pipe、ECS API、RDS、Worker Scheduler、Amplify、公開URL、設定中のimage digestと自動sleep期限を確認する。期限はJST、残時間は時間・分で表示する。秘密値は取得しない。

| Overall        | 意味                                                                                  |
| -------------- | ------------------------------------------------------------------------------------- |
| `NOT_DEPLOYED` | full stackのOutputsがなく、bootstrap-onlyまたは未作成                                 |
| `SLEEPING`     | API 0、RDS stopped、Scheduler disabled                                                |
| `WAKING`       | RDS起動中、またはECS task起動中                                                       |
| `RUNNING`      | API 1、RDS available、Scheduler disabled、HTTP API/VPC Link/Cloud Map/Amplify利用可能 |
| `PARTIAL`      | resource間の状態が不一致。完了扱いにしない                                            |
| `ERROR`        | AWS状態取得に失敗。完了扱いにしない                                                   |

bootstrap-onlyの現在でも`staging:status`は失敗せず`NOT_DEPLOYED`を返す。`wake`と`sleep`はfull stack用Outputが揃うまでAWS writeを拒否する。

## sleepの順序と失敗時

1. 自動sleep期限を現在時刻へ更新し、expired状態を維持する。
2. Worker Schedulerを`DISABLED`にする。既に無効または未作成なら冪等に扱う。
3. ECS APIのdesired countを0にする。
4. ECS APIのrunning/pending countが0になるまで、上限時間付きで待つ。
5. RDSを停止し、`stopped`まで上限時間付きで待つ。
6. 最終statusを表示する。

途中で失敗した場合、成功済み操作は巻き戻さない。たとえばECS停止後にRDS停止が失敗した場合、APIを勝手に再起動せず非ゼロで終了する。表示されたstatusで残っているresourceを確認する。

## wakeの順序と失敗時

1. 利用期限を「現在時刻＋指定時間」としてSSMへ保存する。
2. Worker Schedulerを`DISABLED`に保つ。
3. RDSを起動し、`available`まで上限時間付きで待つ。
4. RDS成功後だけECS APIのdesired countを1にする。
5. ECS serviceがstableになるまで上限時間付きで待つ。
6. `https://api-staging.oshi-schedule.com/health`と`/ready`の両方が2xxになるまで確認する。
7. 最終statusを表示する。

RDS起動に失敗した場合はECSを起動しない。保存済み期限は削除せず、後続のsafety checkが停止方向へ処理できるようにする。readinessだけ失敗した場合は、調査に必要な状態を残すためECS/RDSを勝手に停止せず非ゼロで終了する。

## 自動sleep safety net

staging full stackだけにEventBridge Scheduler、[AWS Lambdaが正式提供する`nodejs22.x`](https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html)、SSM Standard Parameter、CloudWatch Logs、Lambda Errors Alarmを作る。productionと`bootstrapOnly=true`には作らない。

1時間ごとの単純なrate実行にはEventBridge Schedulerが直接Lambdaを起動する構成が最小である。EventBridge Ruleより用途が明確で、SSM Automationのrunbookや追加execution管理も不要なため、Scheduler + Lambdaを採用する。

```text
EventBridge Scheduler（rate(1 hour)）
  → Lambda
    → SSMのUTC期限を確認
    → 期限内: NOOP_ACTIVE
    → 期限切れ: Worker Scheduler無効化 → ECS desiredCount=0 → RDS stop request
```

Lambdaは長時間waitしない。ECSのdesiredCountを0へ更新すると既存taskはECSによって停止され、RDSにはstop requestを送る。各操作は冪等で、既に無効・0・stoppedならwriteしない。途中で失敗した場合は成功済み操作を巻き戻さず、安全な順序を崩す後続操作は行わない。`AUTO_SLEEP_PARTIAL`としてエラー終了するため、既存SNSへ接続したLambda Errors Alarmが通知する。

Lambdaはenvironment `staging`とAWS account `741448960817`を実行時に検証する。SSM GetParameter、対象Worker ScheduleのGet/Update、対象ECS serviceのDescribe/Update、RDS Describeと対象DBのStopだけを許可し、production resourceを操作する権限を持たない。

CloudWatch Logsには`NOOP_NO_DEADLINE`、`NOOP_ACTIVE`、`NOOP_ALREADY_SLEEPING`、`AUTO_SLEEP_TRIGGERED`、`AUTO_SLEEP_PARTIAL`、`AUTO_SLEEP_FAILED`のいずれかを構造化して記録する。Secret、credential、task environmentは記録しない。

## RDSの7日停止制約

[Amazon RDSの公式仕様](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_StopInstance.html)では、手動停止は永久ではなく、停止から7日後も停止中の場合、必要なmaintenance updateを適用できる状態を保つためAWSがDB instanceを自動起動する。したがって`staging:sleep`を一度実行しただけでは、無期限の停止を保証できない。停止中はDB instance時間の課金は止まるが、[RDS for MySQL料金](https://aws.amazon.com/rds/mysql/pricing/)に記載のとおりstorageとbackupは引き続き課金される。

期限は自動sleep後も削除しない。AWSが7日後またはmaintenanceのためRDSを自動起動しても期限切れ状態が残り、1時間ごとのLambdaが`available`へ戻ったDBを再停止する。次に明示的な`staging:wake`を実行したときだけ新しい未来の期限へ更新される。

## Budgetと費用

stagingの月額Budget既定値は`25 USD`である。これはhard spending limitではなく、resourceを自動停止するものでもない。現行CDKは月間予測額がBudgetの80%を超えた時点でSNS通知するため、forecast 20 USDが通知点になる。

計画上の概算は、月40時間で最低/通常/上振れ`$8/$14/$22`、常時稼働で`$32/$42/$55`程度である。HTTP API/Pipes/SQSは低trafficではほぼ従量で、ALB時間固定費はない。実際の請求はRDS稼働時間、Public IPv4、Fargate、Amplify、CloudWatch、保存量と通信量で変わる。25 USDは月40時間運用の上振れを早期検知できるが、常時稼働月は通常利用でも超える。

自動sleepは月約720回のScheduler/Lambda実行である。[EventBridge料金](https://aws.amazon.com/eventbridge/pricing/)のScheduler月1,400万invocation、[Lambda料金](https://aws.amazon.com/lambda/pricing/)の月100万request・40万GB秒、[CloudWatch料金](https://aws.amazon.com/cloudwatch/pricing/)のLogs 5 GB・標準Alarm metric 10個の各Free Tier、[無料のSSM Standard Parameter](https://docs.aws.amazon.com/systems-manager/latest/userguide/ps-default-tier.html)内に収まる想定なので、通常の追加費用は0 USDに近い。Free Tierを使い切った場合も、Schedulerは約0.00072 USD、Lambda/Logsはごく少額、標準Alarm 1個を含めて保守的に月0.15 USD未満を目安とする。料金はregion、ログ量、既存利用量、税で変わるため公開前にPricing Calculatorで再確認する。

## 初回full deploy

初回full staging deployではRDS作成、ECS API起動、migration、HTTPS/API/Web smokeが必要である。最初からdesired countを0にせず、一度`RUNNING`状態で受入確認する。確認終了後に`pnpm staging:sleep`を実行する。

## トラブルシューティング

1. `pnpm staging:status`で不一致または遷移中のresourceを特定する。
2. AWS ConsoleとCloudWatch Logs/alarmsで対象resourceだけを確認する。
3. RDSが`available`になる前にECSを手動起動しない。
4. `PARTIAL`やtimeoutを成功として扱わず、再実行前に前回の成功済み操作を確認する。
5. 調査時もSecret、DB接続文字列、task environmentをterminalやissueへ転記しない。
6. 同期が止まった場合はSyncRunの`QUEUED/RUNNING/FAILED`、sync queue/DLQ、Pipe、targeted ECS taskの順に確認する。PipeがRunTaskを受理した後のtask失敗はSQSだけでは再配信されないため、status APIから再試行するか次回scheduled recoveryを待つ。

## 関連文書

- [staging構築チェックリスト](staging-setup.md)
- [AWS bootstrap](aws-bootstrap.md)
- [費用見積](cost-estimate.md)
- [監視](monitoring.md)
