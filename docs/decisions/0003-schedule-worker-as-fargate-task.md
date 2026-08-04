# ADR 0003: workerをEventBridge SchedulerからFargate Taskとして実行する

## Status

Accepted — 2026-08-04

## Context

workerは1回同期してexitするCLIで、MySQL lease/fencing、Prisma、APIと同じGoogle/YouTube adapterを使う。1時間ごとに実行し、処理結果のexit codeを監視したい。

## Decision

環境別EventBridge Schedulerから、APIと同じimageのworker commandをECS Fargate RunTaskで1時間ごとに起動する。taskの期待上限は45分。Scheduler起動失敗は少数retryとDLQ、起動後のexit 1はECS Task State Change eventで監視する。

## Alternatives

- Lambda: timeout/packaging/Prisma connectionに合わせた変更が必要。
- App Runner常駐worker: 1時間に一度のjobのために常駐費用を払う。
- API内cron: API deploy/restart/scaleとscheduleが結合し重複実行しやすい。
- PaaS cron: AWSのDB/network/log/IAMから運用が分散する。

## Consequences

一回実行型とexit codeを保ち、実行時だけcompute課金される。Fargate task startup latencyは許容する。Scheduler target成功とjob成功が別metricになるため両方を監視する。DB lease/fencingは重複時の安全網として維持する。

## Revisit conditions

1 runが45分を超える、対象channelが100を超える、次回runと頻繁に重なる、部分retry要求が増えた場合はqueueとchannel単位taskへ分割する。
