# ADR 0008: 同期を非同期化しHTTP APIを採用する

## Status

Accepted — 2026-08-12

## Decision

初回・手動同期は既存SyncRunをdurable jobとしてQUEUEDから管理し、encrypted Standard SQS → EventBridge Pipes → shared Fargate Worker Task Definitionで要求時に実行する。APIはsubscription作成を201、手動job受付を202で返し、`GET /api/v1/sync-runs/{id}`で状態を確認する。

public API edgeはALBではなくAPI Gateway HTTP APIの`$default` HTTP_PROXYを使う。VPC LinkがCloud Map SRV serviceからECS API taskのprivate IP:4000をdiscoverする。custom domain/ACM/Route 53 Aliasは維持し、stage名はbackend pathへ渡さない。

## Reasons

HTTP APIのintegration timeoutは最大30秒で、YouTube retry、snapshot wait、逐次Calendar同期をresponse条件にできない。SQS/Pipesはjob損失、retry、DLQ、least-privilege RunTaskをdirect API→ECS RunTaskより明確に扱える。既存Task Definition、SyncRun、SyncLease、stale recoveryを共有でき、常時workerを追加しない。HTTP APIの従量料金へ移すことで低traffic stagingのALB時間固定費を除く。

## Consequences

- deliveryはat-least-onceでありexactly-onceではない。atomic claim、active run dedupe、SyncLease fencing、決定的Calendar event IDを必須とする。
- PipeがRunTaskを受理した後のapplication failureはSyncRun FAILED/stale recovery/manual retry/ECS STOPPED監視で回復する。
- API :4000 ingressはVPC Link SGだけ、worker inboundなし。public IPv4は外部API向けoutbound専用である。
- ECS起動待ちにより同期完了は遅くなるがHTTP requestは通常数秒以内で終了する。frontendは3秒間隔、最大40回pollする。
- ALB、Target Group、Listener、ALB access log bucketは現行templateに作らない。
