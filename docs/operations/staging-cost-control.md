# staging低コスト運用

## 目的と適用範囲

このrunbookは`oshi-schedule-staging`だけを対象にする。VPC、ECR、ALB、Route 53、ACM、Secrets Manager、RDS storageは維持し、未使用時にECS API computeとRDS DB instance computeを止める。productionには適用しない。

コマンドはAWS account `741448960817`、region `ap-northeast-1`、profile `oshi-schedule`、environment `staging`を固定guardとして検証する。`default` profileへfallbackせず、CloudFormation stackのOutputsだけから操作対象を解決する。Secretの取得・表示、resourceの削除、snapshot、rebootは行わない。

## 通常の操作

利用開始：

```bash
pnpm staging:wake
```

状態確認：

```bash
pnpm staging:status
```

利用終了：

```bash
pnpm staging:sleep
```

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

`staging:status`は読み取り専用でCloudFormation、ECS API、RDS、Worker Scheduler、ALB、Amplify、公開URL、設定中のimage digestを確認する。秘密値は取得しない。

| Overall        | 意味                                                          |
| -------------- | ------------------------------------------------------------- |
| `NOT_DEPLOYED` | full stackのOutputsがなく、bootstrap-onlyまたは未作成         |
| `SLEEPING`     | API 0、RDS stopped、Scheduler disabled                        |
| `WAKING`       | RDS起動中、またはECS task起動中                               |
| `RUNNING`      | API 1、RDS available、Scheduler disabled、ALB/Amplify利用可能 |
| `PARTIAL`      | resource間の状態が不一致。完了扱いにしない                    |
| `ERROR`        | AWS状態取得に失敗。完了扱いにしない                           |

bootstrap-onlyの現在でも`staging:status`は失敗せず`NOT_DEPLOYED`を返す。`wake`と`sleep`はfull stack用Outputが揃うまでAWS writeを拒否する。

## sleepの順序と失敗時

1. Worker Schedulerを`DISABLED`にする。既に無効または未作成なら冪等に扱う。
2. ECS APIのdesired countを0にする。
3. ECS APIのrunning/pending countが0になるまで、上限時間付きで待つ。
4. RDSを停止し、`stopped`まで上限時間付きで待つ。
5. 最終statusを表示する。

途中で失敗した場合、成功済み操作は巻き戻さない。たとえばECS停止後にRDS停止が失敗した場合、APIを勝手に再起動せず非ゼロで終了する。表示されたstatusで残っているresourceを確認する。

## wakeの順序と失敗時

1. Worker Schedulerを`DISABLED`に保つ。
2. RDSを起動し、`available`まで上限時間付きで待つ。
3. RDS成功後だけECS APIのdesired countを1にする。
4. ECS serviceがstableになるまで上限時間付きで待つ。
5. `https://api-staging.oshi-schedule.com/health`と`/ready`の両方が2xxになるまで確認する。
6. 最終statusを表示する。

RDS起動に失敗した場合はECSを起動しない。readinessだけ失敗した場合は、調査に必要な状態を残すためECS/RDSを勝手に停止せず非ゼロで終了する。

## RDSの7日停止制約

[Amazon RDSの公式仕様](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_StopInstance.html)では、手動停止は永久ではなく、停止から7日後も停止中の場合、必要なmaintenance updateを適用できる状態を保つためAWSがDB instanceを自動起動する。したがって`staging:sleep`を一度実行しただけでは、無期限の停止を保証できない。停止中はDB instance時間の課金は止まるが、[RDS for MySQL料金](https://aws.amazon.com/rds/mysql/pricing/)に記載のとおりstorageとbackupは引き続き課金される。

自動起動後も`staging:sleep`は現在状態を読み、`available`へ戻ったRDSを安全に再停止できる。週1回以上の`staging:status`確認、利用終了時と請求アラート受信時の`sleep`再実行を当面の運用とする。

毎日自動停止するEventBridge Scheduler + Lambdaは今回は追加しない。staging利用中の誤停止を避けるには「起動許可期限」や明示的なmaintenance tag/SSM flagが必要で、単純な時刻ベース停止は危険だからである。手動運用漏れが実測された場合に、低頻度のScheduler、最小権限Lambda、利用中ガード、通知、監査ログを備えたsafety stopを別工程で検討する。

## Budgetと費用

stagingの月額Budget既定値は`40 USD`である。これはhard spending limitではなく、resourceを自動停止するものでもない。現行CDKは月間予測額がBudgetの80%を超えた時点でSNS通知するため、40 USD設定ではforecast 32 USDが通知点になる。

計画上の概算は、通常の低コスト運用で月35〜50 USD程度、常時稼働では月68〜90 USD程度である。実際の請求はRDS稼働時間、ALB/LCU、Public IPv4、Fargate、Amplify、CloudWatch、保存量と通信量で変わる。Budget 40 USDは早期検知には妥当だが、請求上限ではなく、検証時間が多い月は正常運用でも超える可能性がある。

## 初回full deploy

初回full staging deployではRDS作成、ECS API起動、migration、HTTPS/API/Web smokeが必要である。最初からdesired countを0にせず、一度`RUNNING`状態で受入確認する。確認終了後に`pnpm staging:sleep`を実行する。

## トラブルシューティング

1. `pnpm staging:status`で不一致または遷移中のresourceを特定する。
2. AWS ConsoleとCloudWatch Logs/alarmsで対象resourceだけを確認する。
3. RDSが`available`になる前にECSを手動起動しない。
4. `PARTIAL`やtimeoutを成功として扱わず、再実行前に前回の成功済み操作を確認する。
5. 調査時もSecret、DB接続文字列、task environmentをterminalやissueへ転記しない。

## 関連文書

- [staging構築チェックリスト](staging-setup.md)
- [AWS bootstrap](aws-bootstrap.md)
- [費用見積](cost-estimate.md)
- [監視](monitoring.md)
