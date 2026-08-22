# staging handoff

長い状態説明を毎回プロンプトへ転記せず、この文書を引き継ぎの要約として使う。作業開始時の実状態は、AWS read-onlyの`pnpm staging:preflight`で必ず再確認する。

## 現在状態

2026-08-22 19:18 JSTに`oshi-schedule` profile、`ap-northeast-1`でread-only確認した。

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
| Auto sleep             | `2026-08-22 21:35 JST`まで有効    |

Scheduler実行との競合を避けるため、文書の値だけでAWS writeを判断せず、write前に用途別preflightを再実行する。

AmplifyはApp `oshi-schedule-staging-web`を同じApp IDで維持し、GitHub repository接続済み、`main` Branch 1件、`AVAILABLE`のDomainAssociation 1件という`connected` phaseである。`staging.oshi-schedule.com`はverifiedで`main`に関連付いている。Appの公開環境変数は設定済みで、Amplify jobはまだないため初回build待ちである。

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

## Amplify GitHub接続の段階移行

`infra/config/staging-deploy.json`の`amplifyConnectionPhase`をrepository-managed source of truthとする。Appは全phaseで維持し、`repository`はCloudFormation管理外の一回限りの外部設定とする。

| Phase             | Amplify App | `main` Branch | DomainAssociation | repository期待値 |
| ----------------- | ----------- | ------------- | ----------------- | ---------------- |
| `manual`          | 維持        | あり          | あり              | 未接続           |
| `domain-detached` | 維持        | あり          | なし              | 未接続           |
| `detached`        | 維持        | なし          | なし              | 未接続           |
| `connected`       | 維持        | あり          | あり              | GitHub接続済み   |

移行順は次に固定する。

1. `manual`で`pnpm staging:preflight -- --amplify-manual`を通す。
2. configを`domain-detached`へ変更し、`pnpm staging:preflight -- --amplify-to-domain-detached`を通す。diffがDomain 1件の削除だけであることを確認して承認済みdeployを行う。
3. `pnpm staging:preflight -- --amplify-domain-detached`でDomain 0件、manual Branch 1件を確認する。
4. configを`detached`へ変更し、`pnpm staging:preflight -- --amplify-to-detached`を通す。diffがBranch 1件の削除だけであることを確認して承認済みdeployを行う。
5. `pnpm staging:preflight -- --amplify-detached`でBranch/Domain 0件、repository未接続を確認する。
6. repository accessを許可した短命PATを値が履歴・引数・ログへ残らない方法で一度だけ使い、`UpdateApp`でGitHub repositoryを外部設定する。成功確認後すぐPATを破棄する。
7. `pnpm staging:preflight -- --amplify-repository-connected`でrepository接続済み、Branch/Domain 0件を確認する。
8. configを`connected`へ変更し、`pnpm staging:preflight -- --amplify-to-connected`を通す。diffがBranch/Domain各1件の作成だけであることを確認して承認済みdeployを行う。
9. `pnpm staging:preflight -- --amplify-connected`でDomain `AVAILABLE`まで確認してから、別途承認された初回buildを行う。

2026-08-22に手順1〜8と手順9のconnected preflightまで完了した。`domain-detached` deployはDomainAssociation 1件、`detached` deployは`main` Branch 1件の削除だけだった。`connected` deployはBranch/Domain各1件の作成だけで、DomainはBranch作成後に作成され、各deploy後のCDK diffは0だった。Appは同じApp IDで維持し、repository接続済み、Branch/Domain各1件、Domain `AVAILABLE`である。次回は別途承認された初回buildから再開する。

DomainAssociationを削除してから`connected`で再作成し`AVAILABLE`になるまで、`https://staging.oshi-schedule.com`は停止する。Route 53のAPI用record、API Gateway、Amplify App ID、App環境変数は変更対象外である。Branch/DomainをConsoleやAmplify CLIで直接削除せず、各段階のCloudFormation rollback可能性を維持する。

## 次工程

次は`main`のAmplify初回buildとWeb疎通確認である。`pnpm staging:preflight --amplify-connected`を再実行し、build設定と公開環境変数を値を露出せずread-only確認してから、別途明示承認されたbuildだけを行う。Google OAuthと同期試験はさらに後続の独立工程とする。
