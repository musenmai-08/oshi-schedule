# staging handoff

長い状態説明を毎回プロンプトへ転記せず、この文書を引き継ぎの要約として使う。作業開始時の実状態は、AWS read-onlyの`pnpm staging:preflight`で必ず再確認する。

## 現在状態

2026-08-22 10:04 JSTに`oshi-schedule` profile、`ap-northeast-1`でread-only確認した。

| 項目                   | 状態                              |
| ---------------------- | --------------------------------- |
| CloudFormation         | `UPDATE_COMPLETE`                 |
| Application activation | `READY`（`true`）                 |
| API                    | `desired/running/pending = 1/1/0` |
| RDS                    | `AVAILABLE`                       |
| Pipe                   | `RUNNING`                         |
| Worker Scheduler       | `DISABLED`                        |
| Queue                  | visible `0`                       |
| Cloud Map              | registered instances `1`          |
| Auto sleep             | `2026-08-22 13:28 JST`までACTIVE  |

Auto sleep後はこのsnapshotと実状態が異なるため、文書の値だけでAWS writeを判断しない。

## Task Definitionとruntime image

| Task Definition                   | Revision | Status   |
| --------------------------------- | -------: | -------- |
| `oshi-schedule-staging-api`       |        4 | `ACTIVE` |
| `oshi-schedule-staging-worker`    |        4 | `ACTIVE` |
| `oshi-schedule-staging-migration` |        3 | `ACTIVE` |

3つとも次のimmutable digestを参照する。

```text
sha256:724b4edd23c7b9b71790623414895aa53f0ddc82249b164b9798d09cf756b99e
```

## 解消済み障害

- Secret ARN: API/Workerの4 external Secretを6文字suffix付きcomplete ARNへ統一し、Execution Roleの`secretsmanager:GetSecretValue` Resourceと4/4一致させた。以前の`AccessDenied`は解消済み。
- Prisma Client: production runtime image内で正式schemaからClientを生成するよう修正した。CIのruntime contractでgenerated/importable/constructable、API/Worker/Migration smoke、CA permissionを検証済み。

## 恒久的なAWS安全ルール

- AWS CLI/CDKは`--profile oshi-schedule`、account `741448960817`、region `ap-northeast-1`だけを使用し、`default`を使わない。
- AWS write、migration、ECR変更、ECS scale、Pipe/Scheduler変更、Amplify build、同期実行は、その工程の明示承認後だけ行う。
- 作業前に用途別preflightを実行し、1件でもFAILならwriteへ進まない。既定の`pnpm staging:preflight`はAmplify前を検証する。Phase 2前は`pnpm staging:preflight -- --phase2`を使う。
- Worker Schedulerは明示承認なしに有効化しない。migrationは承認済みone-off Task以外で実行しない。
- runtime imageはimmutable digestで固定し、Secret値・credential・DATABASE_URL・個人情報をログや文書へ出さない。
- 利用終了時は`pnpm staging:sleep`を使い、Auto sleep Schedulerを削除・無効化しない。

## 次工程

次はAmplifyのGitHub App接続と`main`初回buildである。直前に`pnpm staging:preflight`（または明示的に`pnpm staging:preflight -- --amplify`）を実行し、PASS後に別途承認された操作だけを行う。Google OAuthと同期試験は後続の独立工程とする。
