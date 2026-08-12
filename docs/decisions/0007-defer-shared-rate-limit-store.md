# ADR 0007: shared rate-limit storeを水平scale時まで延期する

## Status

Accepted — 2026-08-04

## Context

現行APIはprocess memory内のIP rate limitを持ち、認証後の手動同期にはDB上のcooldown/leaseもある。single taskではmemory counterは一貫するが、複数taskでは共有されない。

## Decision

betaのsingle task中は既存memory storeを使い、API Gateway/VPC Linkの一段だけを信頼する`trust proxy=1`と正確な`X-Forwarded-For`処理を使う。認証routeはuser ID単位制限を優先しIP制限と併用する。desired countを2以上にする**前**にElastiCache for Valkey/Redisを第一候補としてshared storeへ移す。

## Alternatives

- ElastiCacheを初日から導入: 一貫性は高いが固定費、network、backup/patch/monitor対象が増える。
- RDSを全rate counterに利用: 追加DB write/cleanup/lockを主要data storeへ混ぜる。
- IP制限のみ: shared NAT、IPv6、account横断攻撃への精度が不足する。
- 制限なし: OAuth/API quota/同期処理を保護できない。

## Consequences

初期固定費を抑え、single taskでは現行挙動を維持できる。水平scale前のshared store導入がhard prerequisiteになる。VPC Link以外からAPI taskへ直接到達できないsecurity groupを維持し、proxy hop数を変えたら`trust proxy`を再評価する。

## Revisit conditions

API desired count 2、memory rate limit bypass/不整合の観測、複数region、強いabuse、user単位分散limit要件のいずれかが発生した時。ElastiCache Serverlessとprovisioned Valkeyを実traffic/最低費用で比較する。
