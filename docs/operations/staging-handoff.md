# staging handoff

長い状態説明を毎回プロンプトへ転記せず、この文書を引き継ぎの要約として使う。作業開始時の実状態は、AWS read-onlyの`pnpm staging:preflight`で必ず再確認する。

## 現在状態

2026-08-25 21:50 JSTに`oshi-schedule` profile、`ap-northeast-1`でread-only確認した。

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
| Auto sleep             | deadline `2026-08-25 23:18 JST`   |

Scheduler実行との競合を避けるため、文書の値だけでAWS writeを判断せず、write前に用途別preflightを再実行する。

AmplifyはApp `oshi-schedule-staging-web`を同じApp IDで維持し、GitHub repository接続済み、`main` Branch 1件、`AVAILABLE`のDomainAssociation 1件という`connected` phaseである。`staging.oshi-schedule.com`はverifiedで`main`に関連付いている。2026-08-23 20:56 JSTにSSR runtime remediationとしてAmplify AppのBuildSpecだけをin-place updateし、`WEB_ORIGIN`を`apps/web/.env.production`へ生成するコマンドを反映した。CloudFormationは`UPDATE_COMPLETE`、deploy後CDK diffは0である。21:09 JSTにjob `6`を1回だけ開始し、BUILD・DEPLOY・VERIFYすべて`SUCCEED`した。公開トップはHTTP 200で実アプリを返し、認証コードなしの公開`/auth/callback`はHTTP 307で`https://staging.oshi-schedule.com/?error=oauth`へredirectする。

2026-08-23 18:18 JSTに`pnpm staging:wake --hours 2`でwakeした。RDS `AVAILABLE`、API 1/1/0となり、外部`/health`と`/ready`はいずれもHTTP 200で期待する`oshi-schedule-api`応答を返した。wake後preflightは全項目PASSである。

2026-08-25 21:18 JSTに`pnpm staging:wake --hours 2`を1回実行した。21:50 JST時点でRDS `AVAILABLE`、API 1/1/0、Pipe `RUNNING`、Worker Scheduler `DISABLED`、queue 0/0/0で、post-wake preflightは全項目PASSした。外部`/health`と`/ready`はいずれもHTTP 200でservice identityは`oshi-schedule-api`である。wake deadlineは23:18 JSTである。

## 2026-08-25 手動受入結果

`@rindoumikoto`について、staging Webから登録、再Sync、削除、再登録を手動実施した。API Gatewayの匿名化した操作列では、21:34 JSTのresolve `200`・登録`201`、21:39 JSTの再Sync `202`、21:43 JSTの削除`204`、21:45 JSTのresolve `200`・再登録`201`を確認した。同期を伴う登録、再Sync、再登録の3件は、それぞれ独立したWorker taskがexit code `0`で完了し、各`scheduled_sync_completed`は`total=1 / success=1 / skipped=0 / deferred=0 / failed=0`だった。削除は同期を起動しない設計どおり、新しいSyncRunを作成していない。操作列の直前、21:32 JSTにも別の手動Sync 1件が同じ成功結果で完了しているが、ログへhandleを記録しない設計のため対象チャンネルへの帰属は断定していない。

監査時点でsync queue、sync DLQ、Worker Scheduler DLQはいずれもvisible/in-flight/delayed `0/0/0`、Pipeは`RUNNING`、実行中Worker taskは0件、CloudWatch `ALARM`は0件だった。対象時間帯のWorker、API、API Gatewayログには高severity、HTTP 5xx、同期失敗、error codeがなく、YouTube quota reservationは全7件`granted=true`だった。Google CalendarまたはYouTube API由来の想定外エラーも記録されていない。

Calendar同期は、同一user/videoから決定的event IDを生成し、既存mappingとmanaged-fields hashが一致してeventが存在する場合はwriteをskipし、決定的IDのinsertが`409`なら同じeventをpatchする。今回の再Sync・削除・再登録はすべて成功し、Calendarエラーやduplicate conflict failureはないため、重複event生成の兆候はない。RDSはprivate subnet内でECS Execも無効のため、AWS writeなしではSyncRun行やGoogle Calendar実イベント件数を独立して直接照会できない。上記SyncRun判定は、APIのrun polling、taskへ渡されたrun ID、exit code、terminal log、およびterminal log前に`finishSyncRun(SUCCESS)`を保存する実装の突合結果である。

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
- Auto sleep: AWS SDK v3のECS inputを`cluster`/`services`および`cluster`/`service`/`desiredCount`へ修正したLambda Code assetを2026-08-22 22:26 JSTにdeployした。CloudFormationは`UPDATE_COMPLETE`、deploy後のCDK diffは0である。22:39 JSTの既存Scheduler実行は`AUTO_SLEEP_TRIGGERED`で完了し、API 0/0/0の後にRDSが`STOPPED`へ遷移した。今回実行の`AUTO_SLEEP_PARTIAL`、`AUTO_SLEEP_FAILED`、Lambda Errorsはいずれも0である。
- Amplify monorepo build: job `3`のcwd障害をAWS公式の`appRoot`/`buildPath`構成で解消し、remediation deploy後のjob `4`でBUILD・DEPLOY・VERIFYすべての成功と実Web表示を確認した。
- Google OAuth callback origin: BuildSpecから検証済みの非Secret `WEB_ORIGIN` 1行だけを`apps/web/.env.production`へ生成し、Next.js SSR runtimeへ渡すよう修正した。job `6`のbuild logで専用生成コマンドと`.env.production`読込を確認し、公開callbackがlocalhostではなくstaging originへredirectすることを確認した。

## 未解消障害

- バックエンド受入上の機能ブロッカーはない。private RDSとGoogle Calendarの実イベント一覧をAWS writeなしで直接照会する経路はないため、DB行と実イベント件数の独立確認は未実施である。

## 恒久的なAWS安全ルール

- AWS CLI/CDKは`--profile oshi-schedule`、account `741448960817`、region `ap-northeast-1`だけを使用し、`default`を使わない。
- AWS write、migration、ECR変更、ECS scale、Pipe/Scheduler変更、Amplify build、同期実行は、その工程の明示承認後だけ行う。
- 作業前に用途別preflightを実行し、1件でもFAILならwriteへ進まない。既定の`pnpm staging:preflight`はAmplify前を検証する。Phase 2前は`pnpm staging:preflight -- --phase2`を使う。
- sleep中のAmplify control-planeだけを変更する場合は`pnpm staging:preflight --amplify-control-plane`を使い、CDK diffがAmplify Appだけであることを別途確認する。このprofileは意図的にAPI、RDS、Pipe、Queue、wake deadlineを評価しないため、runtime変更には使用しない。
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

2026-08-22に手順1〜8と手順9のconnected preflightまで完了した。`domain-detached` deployはDomainAssociation 1件、`detached` deployは`main` Branch 1件の削除だけだった。`connected` deployはBranch/Domain各1件の作成だけで、DomainはBranch作成後に作成され、各deploy後のCDK diffは0だった。Appは同じApp IDで維持し、repository接続済み、Branch/Domain各1件、Domain `AVAILABLE`である。初回buildは1回だけ実行し、`@oshi-schedule/shared`を解決できず失敗した。再buildはしていない。

DomainAssociationを削除してから`connected`で再作成し`AVAILABLE`になるまで、`https://staging.oshi-schedule.com`は停止する。Route 53のAPI用record、API Gateway、Amplify App ID、App環境変数は変更対象外である。Branch/DomainをConsoleやAmplify CLIで直接削除せず、各段階のCloudFormation rollback可能性を維持する。

## 次工程

今回のOAuth/login、チャンネル登録、再Sync、削除、再登録の手動受入とバックエンド監査は完了した。AWS writeは行わず、明示承認があるまで`pnpm staging:sleep`を含む次の操作へ進まない。
