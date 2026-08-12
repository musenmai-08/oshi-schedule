# staging構築チェックリスト

## 現在地

application、Docker、CDK、GitHub Actions、Amplify build、smoke scriptは実装済みである。CDK assertion/synthとlocal container/smokeは成功しているが、AWS resourceは未作成である。次へ進むにはユーザーによる費用、account、domain、external serviceの判断が必要になる。

## 構築前gate

- [ ] AWS account ID/region/profileと請求先を確定
- [ ] AWS Pricing CalculatorでRDS、ALB、Fargate、public IPv4、Amplify、Logs、Secrets、ECR/S3、Route 53、backupを確認
- [ ] domain/TLD、Route 53 hosted zone、staging Web/API FQDNを確定
- [x] alert emailとstaging monthly Budget 40 USDを確定
- [ ] RDS class/storage/retention/deletion protectionを最終承認
- [ ] GitHub default branchを`main`へ変更し、`staging`/`production` Environmentを作成
- [ ] GitHub ActionsでCI validate/E2Eが成功し、3 workflowがActions画面に表示されることを確認
- [ ] GitHub owner/repository、staging/production Environment方針を確定
- [ ] staging Supabase/Google Cloud projectをproductionと分離
- [ ] OAuth client、YouTube key、allowed email、encryption keyを安全に用意
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`が成功
- [ ] Docker/API/worker/migration、CDK test/synth、YAML/shell検証が成功
- [ ] 実CLI形式の`bootstrapOnly=true` synthでVPC/ECRだけが含まれ、RDS/ECS/ALB/Amplify/Scheduler/Budgetが0件であることを機械確認

## 構築順

1. [AWS bootstrap](aws-bootstrap.md)のECR-first手順を実行する。
2. image scan後のimmutable SHA tagをECRへpushする。
3. Secrets Manager、SSM、Route 53、ACMの入力を準備する。
4. `deployReady=true`のfull `cdk diff`をreviewし、ユーザー承認後だけdeployする。
5. AmplifyとGitHubを管理画面で接続し、custom domainを検証する。
6. Supabase Site URL/Redirect URLとGoogle Cloud authorized originをstaging URLへ変更する。
7. one-off migration、API stable、worker revision、Amplify、smokeの順で確認する。
8. SNS subscriptionを承認し、alarm/Budgetを確認する。
9. workerを一度だけcontrolled runしてからhourly scheduleを有効化する。
10. GitHub Variablesを設定し、最後にstaging自動deploy gateを有効化する。
11. 受入確認後に`pnpm staging:sleep`を実行し、通常の低コスト状態へ移行する。

## 完了条件

- Web/APIがHTTPSのみで、HTTPはredirect。domain未設定の503 listenerを完成扱いにしない
- `/health`はprocess liveness、`/ready`はRDS readinessとして成功
- RDSはMySQL 8.4.10、isolated subnet、public accessなし、TLS required、Single-AZ、20 GiB、backup 1日
- API inboundはALBのみ、DB inboundはAPI/worker SGのみ、worker inboundなし、NAT Gatewayなし
- API desired count 1、circuit breaker、graceful shutdown、CloudWatch Logsが機能
- Schedulerはhourly、retry 2、DLQ、exit非0通知を持ち、lease/fencingを維持
- app Secretがimage、CloudFormation output、Amplify、GitHub logsへ出ていない
- migration task exit 0の後だけAPIがdeployされる
- smoke全項目とalarm通知経路が確認済み

初回構築後は[deployment](deployment.md)、[monitoring](monitoring.md)、[backup](backup-and-recovery.md)を運用runbookとする。
日常の起動・停止は[staging低コスト運用](staging-cost-control.md)に従う。
