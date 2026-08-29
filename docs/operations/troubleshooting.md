# 非同期同期・HTTP APIトラブルシューティング

秘密値、Authorization header、queue message本文、task environment、DB接続文字列はterminal、issue、チャットへ転記しない。

## APIへ接続できない

1. `pnpm staging:status`でHTTP API、VPC Link、Cloud Map、ECS API、RDSを確認する。
2. `SLEEPING`なら承認済み手順で`pnpm staging:wake --hours N`を使う。
3. VPC Linkが`INACTIVE`から復帰中なら最大10分のwaitを許容する。`FAILED`はSG/subnet/integrationを確認する。
4. Cloud Map healthy instanceが0ならECS container `/health`とservice eventを確認する。
5. HTTP API access logはrequest ID、route/status/integration errorだけを確認し、Authorizationを収集しない。

## 同期がQUEUEDのまま

1. sync queueのvisible/oldest message、Pipe state、Pipe roleのSQS consume/ECS RunTask/PassRoleを確認する。
2. messageには`syncRunId`だけが含まれ、Pipe overrideがworker containerの`SYNC_RUN_ID`へ設定されていることをtemplateとtask eventで確認する。
3. dispatch自体が失敗した場合はstatusの`SYNC_DISPATCH_FAILED`を確認し、画面の再試行を使う。永久QUEUEDにはしない。
4. DLQ messageは原因修正前にblind redriveしない。重複deliveryはatomic claimでno-opになるが不要なFargate費用は発生し得る。

### private RDSのread-only候補確認

ECS task実行を明示承認した場合だけ、既存Worker task definitionとPipeのVPC network configurationを再利用して次を実行する。

```bash
pnpm staging:inspect-queued-sync-runs --execute
```

既定の`pnpm staging:inspect-queued-sync-runs`はdry-runであり、taskを起動しない。実行時のcontainer commandは固定の`worker/dist/inspect-queued-sync-runs.js`だけで、`SyncRun`の`count`と`findMany`（`SELECT`）以外を呼ばない。出力は`id`、`status`、`trigger`、`queuedAt`、候補数と`NONE`/`EXACTLY_ONE`/`MULTIPLE`の判定だけである。email、requestedBy ID、token、credential、Calendar IDは出力しない。

`EXACTLY_ONE`以外ではtargeted Workerを起動しない。既存targeted Workerの「候補がちょうど1件」というguardも変更しない。

## RUNNINGが完了しない

1. targeted ECS taskのSTOPPED reason/exit codeとworker logの安全なerror codeをrun IDで照合する。
2. PipeはRunTask受付後のapplication failureをSQSへ戻すとは限らない。SyncRun heartbeatが30分staleになると次のscheduled workerが回収できる。
3. 即時復旧が必要ならterminal状態をstatus APIで確認し、画面から新しいmanual syncを要求する。DB statusの手修正は禁止する。
4. Google再認証、YouTube quota延期、Calendar failureはそれぞれ`FAILED`/`DEFERRED`とphase summaryで区別する。

## 二重実行が疑われる

- 同一subscriptionのactive run IDが1つであること、2 taskのうち1つだけがQUEUED/stale RUNNINGをclaimしたことを確認する。
- `SyncLease` owner/version、deterministic Calendar event ID、Mapping一意制約を無効化しない。
- queue redeliveryやnetwork retryは正常なat-least-once事象であり、exactly-onceと推測しない。

## sleep/wake

HTTP API、VPC Link、Cloud Map、SQS/Pipesはsleep対象外である。sleepはWorker Schedulerをdisable、ECS APIを0、RDSをstopする。wake後はRDS available、ECS stable、`/health`、`/ready`の順に確認し、途中失敗をRUNNINGと報告しない。
