# ADR 0004: MySQLをAmazon RDS for MySQLへ配置する

## Status

Accepted — 2026-08-04

## Context

現行schemaと同期整合性はMySQL、外部キー、transaction、Prisma migration、DB lease/fencingに依存する。stagingとproductionの独立DB、TLS、backup/PITRが必要である。

## Decision

環境ごとにRDS for MySQL 8.4 Single-AZの小さいinstanceと20 GiBから開始する。private subnet、public access無効、TLS CA検証、暗号化、production 7日/staging 1日backupとする。production availability要件上昇時にMulti-AZへ変更する。

## Alternatives

- Aurora Serverless v2: auto-pauseの可能性はあるがhourly workerがwakeさせ、resume latency、Aurora互換性、費用の利点が小規模では不明確。
- Railway等のmanaged MySQL: private connectivity、PITR、region、SLAを同条件で確認できていない。
- PlanetScale等のMySQL互換service: 外部キー、transaction、migration、lease/fencingの完全互換検証が増える。
- SQLite/PostgreSQL: 要件でMySQLを維持し、移行を行わない。

## Consequences

現行Prisma migrationと整合性機構を維持し、AWS network/backupへ統合できる。一方で低trafficでも2環境分の固定費の中心になる。pool上限はtask数に合わせ、migrationは単一taskで実行する。

## Revisit conditions

RDS+ALBがAWS費用の70%超、実請求が見積上限を20%超えて2か月継続、RTO要求が厳格化、DB CPU/connection 70%継続時にAurora、Multi-AZ、別managed MySQLを同条件で比較する。
