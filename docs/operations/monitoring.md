# ログ・監視・アラート

## 目的と初期方針

個人開発のstagingではCloudWatch Logs/Metrics、EventBridge、RDS metrics、AWS Budgets、SNS email通知に絞り、外部APMは導入しない。招待制betaで障害解析に不足が出た場合にtracing/APMを再検討する。

## ログ

| source           | 内容                                                                    | retention                                    |
| ---------------- | ----------------------------------------------------------------------- | -------------------------------------------- |
| API log group    | request ID、route、status、duration、安全なerror code、startup/shutdown | staging 14日、production 30日                |
| worker log group | run ID、対象/成功/失敗/skip件数、quota残量、exit結果                    | staging 14日、production 30日                |
| ECS task event   | start/stop reason、container exit code、deployment failure              | CloudWatch/EventBridgeで通知                 |
| ALB access log   | status、target status、latency、送受信量                                | S3へ90日。個人情報を含むqueryをURLに置かない |
| RDS log          | error、slow query（必要時）                                             | staging 14日、production 30日                |
| CloudTrail       | Secret access、IAM、resource/config変更                                 | AWS標準と監査方針に従う                      |

禁止するログ項目はaccess/refresh token、OAuth code、Secret、API key、`DATABASE_URL`、暗号文、暗号鍵、email、Supabase user ID、Calendar IDである。structured loggerのallowlistを使い、body/header/envの一括dumpをしない。ALB access log bucketにはlifecycleと最小権限を設定する。

## metricsとalarm

初期閾値は暫定であり、2週間の実測baseline後に調整する。

| 対象          | metric / 判定                                           | 初期alarm                                      | 通知・対応                                   |
| ------------- | ------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------- |
| API 5xx       | ALB `HTTPCode_ELB_5XX_Count`                            | 5分で5件以上                                  | SNS email、logをrequest IDで追跡             |
| API latency   | ALB target response p95                                 | 15分で5秒超                                    | manual syncとDB/external latencyを分離       |
| target health | unhealthy target count                                  | 2 datapoints連続で1以上                        | deployment停止/rollback                      |
| ECS resource  | CPU/Memory utilization                                  | 15分で70%超                                    | task size/index/処理を調査                   |
| worker失敗    | ECS STOPPED eventのexit code非0、またはsummary `FAILED` | 1回                                            | run IDで通知、blind retryしない              |
| worker未実行  | 成功/失敗を問わずheartbeat custom metric                | 90分間datapointなし                            | Scheduler、task launch、IAM、quotaを確認     |
| Scheduler     | TargetErrorCount、DLQ message                           | 1回                                            | task起動失敗とworker処理失敗を区別           |
| 同期失敗      | `SyncTargetResult` FAILEDのcustom metric                | 1 runで1以上、または3 run連続partial           | channel/外部API別error codeを確認            |
| 再認証        | `reauthRequired` user数                                 | 1以上                                          | 管理者へ通知し、対象userにはUI案内           |
| YouTube quota | appのscheduled/search残量                               | reserve到達、または残量20%未満                 | 追加fetchを抑制、頻度/増枠を判断             |
| DB接続        | readiness error / Prisma connection error               | 5分で3回                                       | RDS health、SG、TLS、connection数確認        |
| RDS capacity  | CPU、connections、free storage                          | CPU/connection 70%を15分、storage 20%未満      | class/storage/poolを見直す                   |
| backup        | RDS backup event、retention設定監査                     | backup失敗または24時間成功なし                 | snapshot/PITR状態を確認                      |
| cost          | AWS Budget actual/forecast                              | 月予算の50/80/100/120%                         | 80%で原因確認、100%で非必須staging停止を判断 |

CDKはAPI CPU、ALB 5xx、RDS free storage、worker exit非0の4 alarmとSNS、月額forecast 80%のBudget通知を作成する。stagingのBudget既定値は40 USD（forecast通知点は32 USD）、productionの実装既定値は75 USDである。Budgetはhard limitではなくresourceを自動停止しない。`SyncTargetResult`、再認証数、quota残量、worker heartbeat、target latency/healthの追加alarmは現行DB/logから読めるがcustom metric送信は未実装であり、staging baseline取得後の追加課題とする。高cardinalityのuser/channel IDをmetric dimensionに使わない。

## worker監視

EventBridge Schedulerはflexible window off、maximum event age 1時間、retry 2回、SQS DLQで定義する。taskが起動後exit 1になった場合はSchedulerのtarget成功とは別なので、ECS Task State Change eventのcontainer exit code非0をEventBridge ruleで捕捉してSNSへ送る。初回deploy時はscheduleをdisabledとし、Secret、quota、手動worker確認後に有効化する。

DB lease/fencingにより重複taskが同じsubscriptionを同時確定することは防げるが、重複起動を通常運用にしない。Schedulerのflexible time windowはoff、1時間ごと、task executionの期待上限は45分とする。45分超過はalarmと停止automationの対象にし、次回scheduleとの重なりを調査する。

## dashboard

1つのCloudWatch dashboardに環境filter付きで次を置く。

- ALB request/4xx/5xx/p50/p95、healthy targets
- ECS API CPU/memory/restarts、desired/running task数
- worker last heartbeat、duration、exit result、同期成功/失敗件数
- RDS CPU/connections/free storage/read/write latency
- YouTube general/search quota残量、Google reauth count
- month-to-date AWS costとbudget forecast

productionとstagingを同一graphへ混ぜる場合もdimension/colorを明示し、alarmは環境別に作る。

## 障害時の初動

1. deploy時刻、CloudWatch alarm、AWS Health、Supabase/Google statusを確認する。
2. request ID/run IDと安全なerror codeでlogを絞る。Secretを検索結果へ貼らない。
3. API障害は直前task revision、worker障害はschedule/task revision、DB障害はRDS event/connection/storageを確認する。
4. data破損の可能性があればworkerをdisableし、writeを止めてsnapshot/PITR時点を保全する。
5. 復旧後に時系列、影響、検知、対応、再発防止を短いincident noteへ残す。

## 見直し条件

- 月間active userが100人、API desired countが2、または原因不明障害が月2回を超えたらdistributed tracing/APMを評価する。
- log費用がAWS月額の15%を超えたらlevel、retention、samplingを調整する。error/security logを先に削らない。
- pager対応者が2人以上になったらSNS emailからon-call serviceへ移す。

## 関連文書

- [デプロイ](deployment.md)
- [バックアップ・復旧](backup-and-recovery.md)
- [費用見積](cost-estimate.md)
