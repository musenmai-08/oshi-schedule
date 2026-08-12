# ADR 0006: beta APIを単一taskで開始する

## Status

Accepted — 2026-08-04

## Context

招待制betaは10 user程度でtrafficが少ない。現行IP rate limiterはprocess memory内であり、複数instanceではcounterが共有されない。初期から2 tasksとshared storeを持つと固定費と運用対象が増える。

## Decision

staging/productionともAPI desired count 1で開始する。ECS container health checkとrestartを使うが、betaではdeploy/instance障害時の短時間停止を受け入れる。resource/latency/availabilityを観測してproductionだけ2 tasksへ強化する。

## Alternatives

- 最初から2 tasks: availabilityは上がるがcomputeとshared rate-limit storeが先に必要。
- scale-to-zero: cold startと手動同期の予測性を悪化させる。
- Kubernetes: 規模に対して過剰。

## Consequences

費用と運用が小さく、memory rate limiterの一貫性を保てる。rolling deployやAZ障害時の無停止は保証しない。DB lease/fencingはAPI/worker間の同期整合性を維持するがAPI availabilityは補わない。

## Revisit conditions

一般公開、明確なuptime目標、CPU/memory 70%が15分継続、p95 latency超過、deploy停止が許容不能、または月100 active users到達のいずれかでproduction desired count 2以上へ移す。
