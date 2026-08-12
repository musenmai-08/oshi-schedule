# ADR 0002: APIをECS Fargate Serviceで実行する

## Status

Accepted — 2026-08-04（edge部分はADR 0008で更新）

## Context

APIはExpress/Node.js 22、Prisma/MySQLとjob受付を持つ。外部同期はworkerへ分離し、現行構造を大きく変えず将来は複数instanceへscaleできる必要がある。

## Decision

HTTP API + VPC Link + Cloud Map配下のECS Fargate Serviceで実行する。betaは0.25 vCPU/0.5 GiB相当、desired count 1から開始し、image digestでdeployする。graceful shutdown、readiness、`trust proxy=1`を維持する。

## Alternatives

- App Runner: 運用は簡単だがtotal request timeout 120秒が手動同期に不適合。
- Lambda + API Gateway: 同期処理の非同期job化とconnection管理の大きな変更が必要。
- Cloud Run: 有力な低コスト案だが、AWS RDSとのnetwork分散またはCloud SQL移行、cold start/pool検証が増える。

## Consequences

Express containerをそのまま使い、resource/command/networkを制御できる。常駐task、Docker/IaC/ECS運用は必要だがALB時間固定費は除く。single task中はdeploymentで短い停止リスクがあり、一般公開時に2 tasksへ移す。

## Revisit conditions

同期APIを非同期job化した後、API平均利用率が継続して低い、ALB+task固定費が支配的、Fargate運用負荷が個人開発の許容を超える場合にApp Runner/Cloud Run/Lambdaを再比較する。
