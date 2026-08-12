# ADR 0005: stagingとproductionをresource単位で分離する

## Status

Accepted — 2026-08-04; updated by ADR 0008 — 2026-08-12

## Context

実OAuth、YouTube/Calendar、migration、workerをstagingで検証しつつproduction data/credential/quotaへ影響させてはならない。一方、個人開発で複数AWS accountの請求/IAM管理は過剰である。

## Decision

初期は1 AWS account/regionを使うが、VPC、ECS cluster、ECR、HTTP API/VPC Link/Cloud Map、SQS/Pipes、ECS service/task、security group、IAM、RDS、log、Scheduler、Secretを環境別stackへ分ける。GitHub OIDC providerだけはaccount内で共有する。Google Cloud project、Supabase project、DB、OAuth client、YouTube quota、GitHub Environment、domainも分離する。

## Alternatives

- AWS account完全分離: 最も強い境界だが個人betaには運用負荷が高い。
- 同じDB/project/Secretを共有: 誤操作とdata/credential/quota混在を防げない。
- stagingを作らない: 実service/migration/deployの検証要件を満たさない。

## Consequences

外部dataとcredentialに加えnetworkとruntimeも環境別になるため、staging操作がproductionへ波及する範囲を狭められる。同一AWS accountのblast radiusは残るためIAM/tagを厳格にする。productionへのdeployはGitHub Environment manual approvalを必須にする。

## Revisit conditions

開発者/運用者が2人以上、監査/顧客契約/請求分離要件が発生、production規模が一般公開へ到達、account共有の障害範囲が許容できなくなった時にproduction専用AWS accountへ移す。
