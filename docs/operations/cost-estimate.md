# AWS構成と費用見積

## 前提

- 確認日: 2026-08-12、region: `ap-northeast-1`、USD、税・為替・domain年額・supportを除く。
- stagingはHTTP API + VPC Link + Cloud Map、ECS API 0.25 vCPU/0.5 GiB、RDS MySQL `db.t4g.micro`/20 GiB gp3、public IPv4、Amplify、Secrets、Logs/ECR、Route 53を使う。
- sleep中はECS APIを0、RDSをstopped、定期Worker Schedulerをdisabledにする。HTTP API/VPC Link/Cloud Map、queue/Pipe、RDS storage、Secrets、DNS、image/logは維持する。
- 料金は契約・usageで変わるplanning rangeでありquoteではない。deploy承認前に[AWS Pricing Calculator](https://calculator.aws/)で再計算する。

## 公式料金と制約

| 項目                                                                                                | この見積で使う事実                                                      |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [HTTP API](https://aws.amazon.com/api-gateway/pricing/)                                             | request/data transfer従量。低trafficではALBのような時間固定費を持たない |
| [HTTP API quota](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html) | integration timeoutは最大30秒で増枠不可。同期job化が前提                |
| [Cloud Map](https://aws.amazon.com/cloud-map/pricing/)                                              | 登録resource月額とdiscovery request従量。1 API taskの低trafficでは小額  |
| [Fargate](https://aws.amazon.com/fargate/pricing/)                                                  | image pull開始から終了まで、要求vCPU/memoryの秒数で課金                 |
| [SQS](https://aws.amazon.com/sqs/pricing/)                                                          | 1 million requests/月のfree allowance、64 KiB単位。messageはrun IDだけ  |
| [EventBridge Pipes](https://aws.amazon.com/eventbridge/pricing/)                                    | filter後64 KiB request単位。掲載例の基準は$0.40/million                 |
| [RDS MySQL](https://aws.amazon.com/rds/mysql/pricing/)                                              | instance稼働時間、storage、backup。stoppedでもstorage/backupは継続      |
| [Public IPv4](https://aws.amazon.com/vpc/pricing/)                                                  | 使用中IPv4は時間課金。API/workerの外向き通信に利用                      |

## staging月額

| 稼働パターン         | 最低 | 通常 | 上振れ | 主な前提                                                   |
| -------------------- | ---: | ---: | -----: | ---------------------------------------------------------- |
| A. 24時間（730h）    |  $32 |  $42 |    $55 | API/RDS常時、scheduled worker低頻度、少量traffic/log/build |
| B. 平日8時間（176h） |  $12 |  $20 |    $30 | API/RDSだけ利用時間中、schedulerは検証時のみ               |
| C. 月40時間          |   $8 |  $14 |    $22 | auto-sleepを通常運用、storage/Secrets/DNS等は維持          |

旧ALB構成のplanning range（A `$68〜90`、B `$40〜55`、C `$35〜48`）に対し、通常値で月約`$28〜37`削減する見込みである。主因はALB/LCUとALB用public IPv4の常時固定費削除で、HTTP API、Cloud Map、SQS/Pipesの低traffic従量費は小さい。

## 要求時sync jobの追加費用

1 jobあたりone-off Fargate workerを起動する。0.25 vCPU/0.5 GiB、public IPv4、image pullを含め平均5分、上振れ15分として概算する。SQS/Pipesは64 KiB未満1 messageで、この件数ではfree allowanceまたは`$0.01`未満に丸まる。

| job/月 | 通常（5分） | 上振れ（15分） | SQS/Pipes |
| -----: | ----------: | -------------: | --------: |
|     10 |     約$0.02 |        約$0.05 | $0.01未満 |
|    100 |     約$0.17 |        約$0.50 | $0.01未満 |
|  1,000 |     約$1.70 |        約$5.00 | $0.01未満 |

Fargateの起動待ちが利用者のpoll時間へ加わるが、HTTP API requestはjob受付で完了するため起動待ちを課金以外のAPI timeoutへ伝播させない。

## Budget

候補比較は次のとおり。

|  Budget | 評価                                                                 |
| ------: | -------------------------------------------------------------------- |
|     $20 | 月40時間の通常値には合うが、build/logや検証増加で誤報しやすい        |
| **$25** | 月40時間の上振れを検知でき、forecast 80%=$20で早期確認できるため採用 |
|     $30 | 平日8時間の上振れまで許容するが、低利用時の異常検知が遅い            |
|     $40 | 旧ALB構成向け。新しい月40時間運用には緩すぎる                        |

staging既定値を25 USDへ変更し、productionは75 USDを維持する。Budgetはhard limitでも自動sleep triggerでもない。

## さらに安い案

- API/targeted workerをLambdaへ移せばECS API/public IPv4/Cloud Mapを減らせる。ただしprivate MySQLへ接続しつつGoogle/YouTubeへoutboundするにはVPC/NATまたはnetwork再設計が必要で、NAT固定費、connection pool、15分上限、Prisma cold startが利点を打ち消し得る。
- Aurora Serverless v2 + Data API/Lambdaはscale-to-zero余地があるが、MySQL互換・migration・Data API adapter・復帰遅延・最小ACU料金の再検証が必要である。
- Supabase Postgres等へDBを統合すればRDSを除ける可能性があるが、MySQL migration/locking/fencing、private DB要件、障害境界が大きく変わる。
- ECS Express Modeは運用を簡略化できる候補だが、この構成のSQS targeted task、Cloud Map、厳密なSG/IAM/auto-sleepと同条件での費用・制御を確認してから別ADRで評価する。

現時点ではHTTP API + ECS + RDSが、既存コードを維持しながらALB固定費を除く最小変更である。

## 見直し条件

- deploy直前と四半期ごとに東京regionのPricing Calculatorを更新する。
- actual/forecastが25 USDの80%に達したらtag別費用、RDS起動時間、public IPv4、Fargate task時間、logsを確認する。
- sync job平均時間が15分、月1,000件、API desired count 2のいずれかを超えたらtask集約、Fargate Spot、Lambda/Aurora案を再比較する。
- [staging低コスト運用](staging-cost-control.md)の利用期限指定とmanual sleepを通常手順とする。
