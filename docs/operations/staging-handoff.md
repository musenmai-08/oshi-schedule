# staging handoff

長い状態説明を毎回プロンプトへ転記せず、この文書を引き継ぎの要約として使う。作業開始時の実状態は、AWS read-onlyの`pnpm staging:preflight`で必ず再確認する。

## 現在状態

2026-08-29 12:44 JSTに`oshi-schedule` profile、`ap-northeast-1`で再確認した。

| 項目                   | 状態                              |
| ---------------------- | --------------------------------- |
| CloudFormation         | `UPDATE_COMPLETE`                 |
| Application activation | `READY`（`true`）                 |
| API                    | `desired/running/pending = 0/0/0` |
| RDS                    | `STOPPED`                         |
| Pipe                   | `RUNNING`                         |
| Worker Scheduler       | `DISABLED`                        |
| Queue                  | visible `0`                       |
| Cloud Map              | registered instances `0`          |
| Auto sleep             | deadline expired                  |

Scheduler実行との競合を避けるため、文書の値だけでAWS writeを判断せず、write前に用途別preflightを再実行する。

AmplifyはApp `oshi-schedule-staging-web`を同じApp IDで維持し、GitHub repository接続済み、`main` Branch 1件、`AVAILABLE`のDomainAssociation 1件という`connected` phaseである。`staging.oshi-schedule.com`はverifiedで`main`に関連付いている。2026-08-23 20:56 JSTにSSR runtime remediationとしてAmplify AppのBuildSpecだけをin-place updateし、`WEB_ORIGIN`を`apps/web/.env.production`へ生成するコマンドを反映した。CloudFormationは`UPDATE_COMPLETE`、deploy後CDK diffは0である。21:09 JSTにjob `6`を1回だけ開始し、BUILD・DEPLOY・VERIFYすべて`SUCCEED`した。公開トップはHTTP 200で実アプリを返し、認証コードなしの公開`/auth/callback`はHTTP 307で`https://staging.oshi-schedule.com/?error=oauth`へredirectする。

2026-08-23 18:18 JSTに`pnpm staging:wake --hours 2`でwakeした。RDS `AVAILABLE`、API 1/1/0となり、外部`/health`と`/ready`はいずれもHTTP 200で期待する`oshi-schedule-api`応答を返した。wake後preflightは全項目PASSである。

2026-08-25 21:18 JSTに`pnpm staging:wake --hours 2`を1回実行した。21:50 JST時点でRDS `AVAILABLE`、API 1/1/0、Pipe `RUNNING`、Worker Scheduler `DISABLED`、queue 0/0/0で、post-wake preflightは全項目PASSした。外部`/health`と`/ready`はいずれもHTTP 200でservice identityは`oshi-schedule-api`である。wake deadlineは23:18 JSTである。

## 2026-08-25 手動受入結果

`@rindoumikoto`について、staging Webから登録、再Sync、削除、再登録を手動実施した。API Gatewayの匿名化した操作列では、21:34 JSTのresolve `200`・登録`201`、21:39 JSTの再Sync `202`、21:43 JSTの削除`204`、21:45 JSTのresolve `200`・再登録`201`を確認した。同期を伴う登録、再Sync、再登録の3件は、それぞれ独立したWorker taskがexit code `0`で完了し、各`scheduled_sync_completed`は`total=1 / success=1 / skipped=0 / deferred=0 / failed=0`だった。削除は同期を起動しない設計どおり、新しいSyncRunを作成していない。操作列の直前、21:32 JSTにも別の手動Sync 1件が同じ成功結果で完了しているが、ログへhandleを記録しない設計のため対象チャンネルへの帰属は断定していない。

監査時点でsync queue、sync DLQ、Worker Scheduler DLQはいずれもvisible/in-flight/delayed `0/0/0`、Pipeは`RUNNING`、実行中Worker taskは0件、CloudWatch `ALARM`は0件だった。対象時間帯のWorker、API、API Gatewayログには高severity、HTTP 5xx、同期失敗、error codeがなく、YouTube quota reservationは全7件`granted=true`だった。Google CalendarまたはYouTube API由来の想定外エラーも記録されていない。

Calendar同期は、同一user/videoから決定的event IDを生成し、既存mappingとmanaged-fields hashが一致してeventが存在する場合はwriteをskipし、決定的IDのinsertが`409`なら同じeventをpatchする。今回の再Sync・削除・再登録はすべて成功し、Calendarエラーやduplicate conflict failureはないため、重複event生成の兆候はない。RDSはprivate subnet内でECS Execも無効のため、AWS writeなしではSyncRun行やGoogle Calendar実イベント件数を独立して直接照会できない。上記SyncRun判定は、APIのrun polling、taskへ渡されたrun ID、exit code、terminal log、およびterminal log前に`finishSyncRun(SUCCESS)`を保存する実装の突合結果である。

バックエンド最終監査後の22:06 JSTに`pnpm staging:sleep`を1回実行した。sleep前はpreflight全項目PASS、API 1/1/0、RDS `AVAILABLE`、全queue 0/0/0だった。22:16 JSTにAPI 0/0/0、RDS `STOPPED`、Cloud Map登録0、最終status `SLEEPING`を確認した。sync queue、sync DLQ、Worker Scheduler DLQはいずれもvisible/in-flight/delayed `0/0/0`を維持し、想定外エラーはなかった。これをもって今回のstaging手動受入テストを完了とする。

## 2026-08-26 定期自動同期受入結果

sleep中のstatusとAmplify control-plane preflightを確認後、`pnpm staging:wake --hours 2`でRDS `AVAILABLE`、API 1/1/0、外部`/health`・`/ready` HTTP成功まで確認した。Worker Schedulerは既存の`rate(1 hour)`、flexible window `OFF`、maximum event age 1時間、retry 2回、Fargate targetを保持し、22:24:45 JSTにStateだけを一時的に`ENABLED`へ変更した。

実Schedulerは22:25:26 JSTに、`SYNC_RUN_ID` overrideのない定期全件Worker taskを1件だけ起動した。taskはexit code `0`で終了し、`scheduled_sync_completed`は`total=2 / success=2 / skipped=0 / deferred=0 / failed=0`だった。YouTube quota reservation 5件はすべて`granted=true`で、対象時間帯のWorker high-severity、同期失敗、error code、Calendar API・YouTube API由来エラーは0件だった。sync queue、sync DLQ、Worker Scheduler DLQはすべて0/0/0、CloudWatch `ALARM`も0件である。

2対象ともterminal summaryがSUCCESSで、既存の決定的Calendar event ID・mapping/hash skip・insert conflict時patchにより、今回も重複Calendar event生成の兆候はない。private RDSとGoogle Calendar実イベント一覧を直接照会するread-only経路はないため、SyncRun行と実イベント件数の独立照会は未実施である。

確認後の22:27 JSTにSchedulerを既存設定のまま`DISABLED`へ戻し、実行中Worker 0を確認した。22:29 JSTに`pnpm staging:sleep`を1回実行し、22:38 JSTにAPI 0/0/0、RDS `STOPPED`、Cloud Map登録0、status `SLEEPING`、全queue/DLQ 0/0/0を確認した。手動Worker起動、migration、ECR/CDK/Amplify変更は行っていない。

## Task Definitionとruntime image

| Task Definition                   | Revision | Status   |
| --------------------------------- | -------: | -------- |
| `oshi-schedule-staging-api`       |        6 | `ACTIVE` |
| `oshi-schedule-staging-worker`    |        6 | `ACTIVE` |
| `oshi-schedule-staging-migration` |        5 | `ACTIVE` |

3つとも次のimmutable digestを参照する。

```text
sha256:a8d9a7fa64246f6b035a1c551561de5678ee9c39830858dd058fcd46e239f1c1
```

## 解消済み障害

- Secret ARN: API/Workerの4 external Secretを6文字suffix付きcomplete ARNへ統一し、Execution Roleの`secretsmanager:GetSecretValue` Resourceと4/4一致させた。以前の`AccessDenied`は解消済み。
- Prisma Client: production runtime image内で正式schemaからClientを生成するよう修正した。CIのruntime contractでgenerated/importable/constructable、API/Worker/Migration smoke、CA permissionを検証済み。
- Auto sleep: AWS SDK v3のECS inputを`cluster`/`services`および`cluster`/`service`/`desiredCount`へ修正したLambda Code assetを2026-08-22 22:26 JSTにdeployした。CloudFormationは`UPDATE_COMPLETE`、deploy後のCDK diffは0である。22:39 JSTの既存Scheduler実行は`AUTO_SLEEP_TRIGGERED`で完了し、API 0/0/0の後にRDSが`STOPPED`へ遷移した。今回実行の`AUTO_SLEEP_PARTIAL`、`AUTO_SLEEP_FAILED`、Lambda Errorsはいずれも0である。
- Amplify monorepo build: job `3`のcwd障害をAWS公式の`appRoot`/`buildPath`構成で解消し、remediation deploy後のjob `4`でBUILD・DEPLOY・VERIFYすべての成功と実Web表示を確認した。
- Google OAuth callback origin: BuildSpecから検証済みの非Secret `WEB_ORIGIN` 1行だけを`apps/web/.env.production`へ生成し、Next.js SSR runtimeへ渡すよう修正した。job `6`のbuild logで専用生成コマンドと`.env.production`読込を確認し、公開callbackがlocalhostではなくstaging originへredirectすることを確認した。

## 未解消障害

- バックエンド受入上の機能ブロッカーはない。private RDSとGoogle Calendarの実イベント一覧をAWS writeなしで直接照会する経路はないため、DB行と実イベント件数の独立確認は未実施である。
- `calendar.app.created`対応版のruntime candidateはECR scanで未登録OpenSSL HIGH 3件を検出したため未deployである。例外台帳に従い、新findingを自動受容せず、CloudFormationとAmplifyへの追加writeを停止している。

## 2026-08-26 リリース前最終監査

[リリース前最終監査](../reviews/pre-release-final-audit.md)を実施した。定期同期は要件・設計・IaC・AWS実設定・運用文書で`rate(1 hour)`へ統一し、CDK phase2 diff 0、Web 200、callbackのstaging origin redirect、RDS非公開、Queue/DLQ滞留0、Alarm 0をread-onlyで再確認した。招待制stagingの技術的受入は完了している。

production一般公開は、正式な利用規約/プライバシーポリシーとGoogle OAuth scope/審査判断のHigh 1件が残るため未準備である。Scheduler DLQのTLS必須policyと2026-09-11期限のContainer CVE例外再審査をMediumとして追跡する。機能コード、AWS resource、DB、OAuth/Syncは変更していない。

## 2026-08-27 production公開設定guard修正

最終監査High 1を解消した。production full deployは、domain/certificate/Supabase URL・publishable key/Google Client IDを単一のCDK configで検証し、現在のstaging公開値はSHA-256 fingerprintとの一致で拒否する。staging/dev/local/予約済みhost、localhost、placeholder、certificateのaccount/region不一致、可変image tagもfail-fastする。productionのSupabase URLとGoogle Client IDはこの検証済みconfigから環境固有SSM String Parameterを作るため、AmplifyとECSで別の値を手作業投入しない。stagingの既存SSM参照と`infra/config/staging-deploy.json`は変更していない。

API runtimeもproduction/realで`WEB_ORIGIN`と`ALLOWED_EMAILS`を明示必須とし、production originはHTTPS originだけ、開発用allowlist既定値は拒否する。ローカルreal-modeは明示したlocalhost設定を維持できる。Node.js 22.23.1でtypecheck、lint、全test、staging/production synthを通し、AWS read-onlyのstaging phase2 diff 0を確認した。AWS resourceへのwrite/deployは行っていない。公開値fingerprintの対象をrotationした場合は、production diff前に[`environment-boundary.ts`](../../infra/lib/environment-boundary.ts)を更新し、必ず二環境の値を再照合する。

## 2026-08-27 production OAuth・法務表示High 2詳細監査

[High 2詳細監査](../reviews/high-2-production-oauth-legal-audit.md)を実施した。公開中のstaging `/terms`と`/privacy`はHTTP 200だが、デモ警告、未定の問い合わせ先、未定の保存期間、Limited Use確認の予告が実ページにも残る。production URLは未確定で、文書の`app.example.com`はplaceholderである。

Calendar scope最小化コードは`https://www.googleapis.com/auth/calendar.app.created`へ統一した。identity 3種を維持し、`include_granted_scopes=false`、refresh token交換応答による実scope検証・保存、旧Calendar grant拒否、scope不足時の再同意誘導を実装した。未使用のprovider access tokenはcallback/API契約から除外した。app-created calendarのget/create/deleteとevent CRUDはscope contract testで固定した。

AWS、Google Cloud、Supabase、DB実データ、OAuth grantは変更しておらず、deployと実OAuth再試行も行っていない。既存staging利用者のDB scope行は再同意まで自動移行しない。限定scope受入では、当該Google projectを未許可の利用者を使うか、Google Account側で既存grantを明示revokeしてから同意し、実grantとDB保存scopeに広いCalendar scopeがないことを匿名化して確認する。詳細手順は[High 2詳細監査](../reviews/high-2-production-oauth-legal-audit.md)のC項をsource of truthとする。

2026-08-28に利用制限で中断した未commit差分を保持したままレビューを再開し、関連test、lint、typecheck、Amplify相当のproduction buildを完了した。全testは既存infra synth testの並列時timeoutを避けるため直列でも再確認し、全suiteが成功した。AWS write、deploy、OAuth再実行は行っていない。

## 2026-08-28 `calendar.app.created` staging deploy事前ゲート

`main`のCI成功とcleanなGit、Amplify control-plane preflight全PASS、CloudFormation phase2 diff 0を確認した。stagingはAPI 0/0/0、RDS `STOPPED`、Worker Scheduler `DISABLED`、queue 0の`SLEEPING`を維持している。Prisma schema差分はないためmigrationは実行していない。

commit `3d6e82e65c56817407cf685293e643171327a11f`から`linux/amd64` runtime imageをbuildし、Node.js 22.23.1、non-root、Prisma Client、RDS CAを含むruntime contractを検証した。Trivy 0.73.0の最新DBと有効期限内の`.trivyignore`によるHIGH/CRITICAL policy scanは0件で成功した。検証済みimageだけをimmutable commit tagでstaging ECRへpushし、candidate digestを次で確定した。

```text
sha256:42c35efdd0b3ae46b2d806acc31ce5e1996ffd06c5cf75541ccd1a41786162a6
```

ECR Basic ScanはCRITICAL 3 / HIGH 8を報告した。CRITICAL 3とHIGH 5は既存例外台帳と一致するが、`openssl` `3.0.20-1~deb12u2`に対する`CVE-2026-54874`、`CVE-2026-63072`、`CVE-2026-63076`のHIGH 3件は未登録で、scan上のfixed versionも空だった。新findingを自動で例外化しない恒久ルールに従い、`infra/config/staging-deploy.json`の稼働digestは変更せず、CDK deployとAmplify buildを実行していない。CloudFormation、Task Definition、Webは旧digest/versionのままである。

3件を再審査した結果、bookworm/bookworm-securityの候補は引き続き`3.0.20-1~deb12u2`で、修正済みbookworm packageはない。OpenSSL upstreamの修正版は3.0.22である。`node:22.23.1-trixie-slim`へ変更したlocal candidateは修正済み`3.5.7-1~deb13u2`を取得しruntime contractにも合格したが、raw Trivy scanで別の未登録HIGHを導入したため、base OS移行を採用せずDockerfileは変更していない。

対象経路はそれぞれDTLS endpoint、CMS decrypt、CMP client/serverである。アプリはHTTP/HTTPSとMySQL TLSだけを利用し、UDP/DTLS、CMS、CMPを実装・起動しない。Prisma query engineはsystem `libssl3`へlinkするが、利用経路はMySQL TLSに限定される。project ownerはこの3件をstaging runtime限定、期限2026-09-11で承認した。共通の`.trivyignore`は変更せず、3件を追加した`.trivyignore.staging`をstaging scanだけが使用する。production workflowは共通policyを使い続け、ECR scanに3件のいずれかがあればpromotion前にfailする。詳細は[例外台帳のstaging限定例外](../security/container-vulnerability-exceptions.md#staging-only-ecr-openssl-exceptions-approved-2026-08-28)を参照する。

AWSへ送らないlocal candidate `oshi-schedule:openssl-exceptions-staging`を`linux/amd64`で再buildした。local image IDは`sha256:e334d73a37b241cde63f2ec31b8d25751b234e8f5e58e70cdcf60848b1aaee39`で、OpenSSL/libssl3は審査対象の`3.0.20-1~deb12u2`と一致する。Node.js 22.23.1、non-root、Prisma Client、RDS CAを含むruntime contractは合格した。

Trivy 0.73.0の2026-08-28最新DBによるraw scanは既知14 CVE ID、30 findings（CRITICAL 4 / HIGH 26）で、新規IDはない。`.trivyignore.staging`によるpolicy scanはexit 0、未承認CRITICAL/HIGH 0件だった。承認したOpenSSL 3件はECR固有のためraw Trivyには現れないが、専用policy、例外台帳、対象package versionの一致を確認した。ECR push、CDK deploy、Amplify buildを含むAWS writeは行っていない。

candidate検証blockerは解消した。次は別途承認された工程でのみ、current commitからimmutable imageをstaging ECRへpushし、ECR scan再確認、digest config更新、限定CDK diff、sleep中deploy、Amplify buildの順に再開する。productionへ同じ例外を持ち込むことはできない。

2026-08-28 22:43 JSTにcurrent commit `270c05cca2bd258eca7e21849a74b6a7c3a4dd51`のcandidateを、staging ECRへimmutable tagでpushした。確定digestは次である。

```text
sha256:781ed5a511661695bcfa43ae0930055da195a8d396ca2cb5d3a01a96594ccb6e
```

ECR Basic Scanは`COMPLETE`となり、CRITICAL 3 / HIGH 8（合計11件）のCVE IDとpackage versionを確認した。11件は既存台帳の例外または今回承認したstaging runtime限定OpenSSL 3件と全て一致し、未承認CRITICAL/HIGHは0件だった。ECR pushとscan確認以外のAWS write（CDK/CloudFormation、ECS、RDS、Amplify、wake）は行っていない。production promotion workflowはstaging限定3件を検出したdigestを拒否する。

2026-08-28 22:59〜23:03 JSTに、`infra/config/staging-deploy.json`へこのdigestを反映したPhase 2 CDK deployを実施した。許容した主差分はAPI/Worker/Migration Task Definitionのdigest更新3件で、依存するECS Service、Pipe、Scheduler、IAM policyも新Task Definition ARN追随のupdateとなった。CloudFormationは`UPDATE_COMPLETE`、deploy後CDK diffは0である。deploy中はCloudFormationがtemplate上のService desired countを再適用したためAPIが一時的に1/1/0へ起動したが、`pnpm staging:sleep`で復旧した。

現在はAPI 0/0/0、RDS `STOPPED`、Worker Scheduler `DISABLED`、Cloud Map登録0、status `SLEEPING`で、API/Worker/MigrationのTask Definitionはすべてこのdigestを参照する。Amplify build、OAuth、migration、同期は実行していない。productionへはstaging限定例外を含むため昇格できない。

2026-08-29に承認済みWorker env validation修正版digestを`infra/config/staging-deploy.json`へ反映し、commit `465216b`としてpushした。sleep状態対応の`--runtime-deploy-sleeping` preflightは全PASS、Phase 2 CDK diffはAPI/Worker/Migration Task Definitionのruntime digest更新3件だけだったため、承認済みPhase 2 CDK deployを実行した。CloudFormationは`UPDATE_COMPLETE`、Task DefinitionはAPI rev6 / Worker rev6 / Migration rev5へ更新され、3つすべてが指定digestを参照している。deploy中にAPIは一時1/1/0へ起動したが、`pnpm staging:sleep`でAPI 0/0/0、RDS `STOPPED`、Scheduler `DISABLED`、queue 0、最終status `SLEEPING`へ復旧した。deploy後CDK diffは0である。

2026-08-28 23:16〜23:20 JSTにAmplify `main`のjob `7`を1回だけ実行し、BUILD/DEPLOY/VERIFYすべて`SUCCEED`した。接続済みmainのHEAD（OAuth `calendar.app.created`最小scope実装を含む）をbuildし、`https://staging.oshi-schedule.com/`はHTTP 200で実アプリの識別表示を返し、Welcomeプレースホルダーではなかった。build中もAPI/RDSをwakeせず、完了後のstatusはAPI 0/0/0、RDS `STOPPED`、Scheduler `DISABLED`、`SLEEPING`である。OAuth実ログイン、Sync、wakeは行っていない。

2026-08-29の限定scope受入で、targeted Worker taskが起動直後に`ALLOWED_EMAILS`欠落でexit code 1となった。allowlistはHTTP APIの招待制認可だけで使用し、Workerの同期経路では使用しない。原因はAPI/Worker共通runtimeがAPI専用のallowlist必須validationを実行したことだった。未deployの修正ではruntime validationをAPI/Workerで分離し、APIのproduction/real allowlist必須契約を維持したまま、Workerはallowlistを注入せず起動可能にする。Task DefinitionのWorker/Migrationにallowlistを渡さない契約と、real-mode Worker起動、queued targeted SyncRunの次Worker起動時回復を回帰テストで固定した。

今回Pipeが起動したWorkerはruntime初期化前に停止したため、対象SyncRunはclaimされず`QUEUED`のまま残る。次の正常なWorker起動では`runPendingManual`がqueued targeted runを回収する。Worker Schedulerは通常`DISABLED`のため、deploy後は明示承認されたWorker実行またはScheduler一時有効化でこの既存runを1回だけ回復確認する。AWS/DB/Calendar write、image push、deploy、再Syncはこの調査・修正では行っていない。

2026-08-29にWorker env validation修正版（commit `e5eb939`）のcandidateをECRへpushし、digest `sha256:a8d9a7fa64246f6b035a1c551561de5678ee9c39830858dd058fcd46e239f1c1`でBasic Scanを再確認した。CRITICAL 3 / HIGH 9のうち、`CVE-2026-12087`、`CVE-2026-48959`、`CVE-2026-48961`、`CVE-2026-7017`は、既存の[staging-only ECR exceptions](../security/container-vulnerability-exceptions.md#staging-only-amazon-ecr-basic-scanning-exceptions-approved-2026-08-29)としてowner承認済みの`perl` source-package由来4件だった。`perl-base`は公式`node:22.23.1-bookworm-slim`に含まれるEssential packageであり、アプリが追加した依存ではない。runtimeには`Socket`だけが存在し、`IO::Compress`/`IO::Uncompress`、`HTTP::Tiny`、`zipdetails`は存在せず、API/Worker/entrypointもPerlを起動しない。特にCVE-2026-48961について、Debianの`libio-compress-perl`はbookwormでnot-affectedだが、ECRはsource package `perl`へ広く紐付けて報告しているため、画像内の実module不在と矛盾しない。bookwormには4件の適用可能な修正版がないため、Essential packageの強制削除やbase OS変更は最小・安全な修正ではない。既存例外の期限（2026-09-11）までの受容条件・production promotion前の再審査を維持する。今回新しい例外、Dockerfile変更、AWS writeは行っていない。

2026-08-29に既存の限定scope受入由来のtargeted `QUEUED` SyncRunだけを、`SYNC_RUN_ID` override付きWorker taskで1回だけ回収した。wake後はRDS `AVAILABLE`、API `1/1/0`、通常preflight、`/health`、`/ready`がすべて正常だったが、Workerはexit code `1`で停止し、安全なterminal logは`WORKER_UNHANDLED_ERROR`（`total=0`）のみだった。旧`ALLOWED_EMAILS`欠落ではなくruntime初期化後のアプリケーション処理失敗であることは確認できた一方、ログは意図的に詳細を出さないため、Calendar API／scope／permission由来かはこの受入操作だけでは確定していない。再実行、再Sync、Scheduler有効化は行っていない。sync queue、sync DLQ、Worker Scheduler DLQはいずれも`0/0/0`のままである。最後に`pnpm staging:sleep`を実行し、API `0/0/0`、RDS `STOPPED`、Scheduler `DISABLED`、Cloud Map `0`、status `SLEEPING`へ復旧した。次回はWorkerの安全な分類済みエラー観測を追加してから、失敗原因を修正・検証する。

2026-08-29に直前Workerのlogと実行経路を再調査した。terminal summaryが出ているためruntime初期化は通過しており、`syncSubscription`内で必ず出る`subscription sync failed`構造化ログもないことから、最有力箇所は`claimSyncRun`のPrisma transaction（またはその直後のDB read）である。既存ログだけでは確定できないため、推測でDB、Google、Calendarのいずれかを断定しない。次runtimeでは、初期化、SyncRun claim、Prisma DB、credential復号、Google認証、YouTube、Calendar、同期処理、shutdownを固定の安全なphaseへ分類し、terminal worker logへ`failurePhase`、`failureCode`、`failureClass`だけを出力する。raw error message、token、secret、credential、メール、ID、Calendar IDは出力しない。次回はこのruntimeをdeployした後、別途承認されたtargeted Workerを1回だけ実行して、`SYNC_RUN_CLAIM`／`DATABASE`または外部API分類を確認する。

この観測追加の初回CIでは、分類wrapperが既存のin-process error messageを置き換え、initial sync失敗時の既存契約testを壊した。wrapperのWorker logは分類値だけに保ったまま、呼出元に渡すmessageは元のError messageを維持する最小修正を追加した。API full test 148 passed（MySQL integration 8 skipped）、Worker関連17 passed、両workspaceのtypecheckとlintが成功している。

## 恒久的なAWS安全ルール

- AWS CLI/CDKは`--profile oshi-schedule`、account `741448960817`、region `ap-northeast-1`だけを使用し、`default`を使わない。
- AWS write、migration、ECR変更、ECS scale、Pipe/Scheduler変更、Amplify build、同期実行は、その工程の明示承認後だけ行う。
- 作業前に用途別preflightを実行し、1件でもFAILならwriteへ進まない。既定の`pnpm staging:preflight`はAmplify前を検証する。Phase 2前は`pnpm staging:preflight -- --phase2`を使う。
- sleep中のruntime digest更新前は`pnpm staging:preflight --runtime-deploy-sleeping`を使う。このprofileはPhase 2起動用`--phase2`の期待値を変更せず、activation `READY`、API `0/0/0`、RDS `STOPPED`、Pipe `RUNNING`、Scheduler `DISABLED`、queue `0/0/0`、wake deadline `EXPIRED`を検証する。
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

2026-08-29に、current HEAD由来のWorker分類済みエラー観測candidateをstaging ECRへpushし、digest `sha256:c7f1893e2317012c14fb77710fbb87b78d6c48db47dd186c264c71566021b7b6`を確定した。ECR Basic ScanはCOMPLETE（CRITICAL 3 / HIGH 9）で、既存のproduction例外および承認済みstaging限定例外だけに一致し、未承認Critical/Highは0件だった。production policyへのstaging限定例外混入もない。

同digestを`infra/config/staging-deploy.json`へ反映し、`--runtime-deploy-sleeping` preflight（API 0/0/0、RDS STOPPED、Pipe RUNNING、Scheduler DISABLED、queue 0、wake deadline EXPIRED）とruntime-only CDK diff（API/Worker/Migration Task Definition更新3件）を確認してPhase 2 deployを実施した。CloudFormationは`UPDATE_COMPLETE`、API/Worker/Migrationの全Task Definitionが同digestを参照し、deploy後CDK diffは0だった。deploy中にAPIが一時起動したため`pnpm staging:sleep`で復旧し、現在はAPI 0/0/0、RDS `STOPPED`、Worker Scheduler `DISABLED`、Cloud Map登録0、status `SLEEPING`である。Worker実行、OAuth、Sync、Amplify build、migrationは行っていない。

2026-08-29に分類済みエラー観測runtimeで既存のtargeted `QUEUED` SyncRun回収を試行した。`pnpm staging:wake --hours 1`後、RDS `AVAILABLE`、API `1/1/0`、`/health`・`/ready` HTTP 200を確認した。停止済みECS taskの保持期限によりrun IDを外部メタデータから復元できなかったため、承認されたWorker taskを1回だけ起動し、container内で`QUEUED`かつ`INITIAL`/`MANUAL`のrunがちょうど1件であることをread-only照会してから、そのIDだけを`SYNC_RUN_ID`へ設定する保護手順を用いた。

この照会は`queued_sync_run_count_mismatch`で安全に停止し、taskはexit `64`となった。Worker本体は開始されなかったため、`failurePhase`/`failureCode`/`failureClass`は生成されず、SyncRun claim、Google認証、YouTube、Calendar、scope/permission処理も実行されていない。新しい再Syncは作成しておらず、sync queue、sync DLQ、Worker Scheduler DLQはいずれも0/0/0だった。再実行はしていない。`pnpm staging:sleep`によりAPI 0/0/0、RDS `STOPPED`、Scheduler `DISABLED`、Cloud Map登録0、status `SLEEPING`へ復旧した。

private RDSの既存`QUEUED`候補を安全に確認するため、Worker imageに`worker/dist/inspect-queued-sync-runs.js`を追加した。このentry pointは`SyncRun`の`count`と`findMany`だけを使い、`INITIAL`/`MANUAL`かつ`QUEUED`の候補について`id`、`status`、`trigger`、`queuedAt`、候補数と`NONE`/`EXACTLY_ONE`/`MULTIPLE`だけをJSON出力する。email、requestedBy ID、token、credential、Calendar IDは選択・出力しない。`pnpm staging:inspect-queued-sync-runs`はdry-runで、既存Worker task definitionとPipeのVPC設定、およびprivate RDSへの既存経路をread-only確認するだけである。実DB照会は別途AWS task実行を承認した場合の`pnpm staging:inspect-queued-sync-runs --execute`だけが行い、固定されたinspection command以外をoverrideできない。対象imageのbuild/push/deploy後にこの結果が`EXACTLY_ONE`であることを確認してから、別途承認したtargeted Workerを1回だけ起動する。

2026-08-30に、承認済みqueued SyncRun inspector candidateのdigest `sha256:d01f26c49a7c5fb02cfa84878d54346e31a7398c84650a81f2405f70e6eaf7b2`を`infra/config/staging-deploy.json`へ反映し、`--runtime-deploy-sleeping` preflight全PASS後にPhase 2 CDK deployを実施した。差分はAPI/Worker/Migration Task Definitionのruntime digest更新3件のみで、CloudFormationは`UPDATE_COMPLETE`となった。3つすべてのTask Definitionが指定digestを参照している。deploy中にAPIが一時1/1/0へ起動したため`pnpm staging:sleep`で復旧し、現在はAPI 0/0/0、RDS `STOPPED`、Worker Scheduler `DISABLED`、queue 0、status `SLEEPING`、deploy後CDK diff 0である。inspector、Worker、Sync、OAuth、Amplify buildは実行していない。

2026-08-30に、stagingを1時間wakeしてAPI 1/1/0、RDS `AVAILABLE`を確認後、`pnpm staging:inspect-queued-sync-runs --execute`を1回だけ実行した。既存`QUEUED`かつ`INITIAL`/`MANUAL`の候補は0件で、結果は`READ_ONLY`・`NONE`（`candidateCount=0`）だった。inspectorは`count`/`findMany`のみを実行し、claim・更新・削除・Worker処理・Sync・OAuth・Calendar writeは行っていない。確認後に`pnpm staging:sleep`を実行し、API 0/0/0、RDS `STOPPED`、Worker Scheduler `DISABLED`、queue 0、status `SLEEPING`へ復旧した。

INITIAL/MANUAL SyncRunの最終状態を確認するときは`pnpm staging:inspect-sync-run-states`を使用する。このモードは既存queued inspectorと同じprivate RDSへの経路を使い、Prismaの`count`/`findMany`のみで`INITIAL`/`MANUAL`を取得する。出力は`id`/`status`/`trigger`/`queuedAt`/`startedAt`/`completedAt`/`errorCode`と件数の安全なサマリのみで、email、token、credential、raw error messageは選択・出力しない。claim、INSERT、UPDATE、DELETEは行わない。フラグを付けたAWS task実行は別途承認が必要であり、本番受入では実行しない。

## 次工程

今回のOAuth/login、チャンネル登録、再Sync、削除、再登録、定期Scheduler同期の受入、バックエンド監査、staging sleep、リリース前最終監査は完了した。招待制stagingは技術的受入完了で`SLEEPING`を維持する。production公開設定guardとOAuth scope最小化コードは解消済みで、一般公開へ残るHighは[High 2詳細監査](../reviews/high-2-production-oauth-legal-audit.md)の限定scope実受入、法務表示、branding、production外部設定・公開審査である。次は新runtime candidateのECR固有OpenSSL 3件について、2026-09-11までの期限付き例外を明示承認するか判断する。承認後に限定deployを再開し、その完了後、Google/Supabase Data Access変更と旧grantを排除したstaging手動受入を別途承認の上で行う。

2026-08-30にcurrent HEAD `d233f73`由来の検証済みruntime candidateをstaging ECRへimmutable tag `d233f73`でpushし、digest `sha256:8eab040ceaf8b53b967ca07205198d54a3c6bcb503f5dc04f74a0b7ccca1da95`を確定した。ECR Basic Scanは`COMPLETE`（CRITICAL 3 / HIGH 9）で、既存production例外または承認済みstaging限定例外だけに一致し、未承認Critical/Highは0件だった。そのdigestをPhase 2 CDK deployでAPI/Worker/Migration Task Definitionへ反映し、CloudFormation `UPDATE_COMPLETE`、deploy後CDK diff 0、全Task Definitionのdigest一致を確認した。deployに伴い一時起動したAPIは`pnpm staging:sleep`で停止し、現在はAPI 0/0/0、RDS `STOPPED`、Worker Scheduler `DISABLED`、Cloud Map登録0、status `SLEEPING`である。inspector、Worker、Sync、OAuth、Amplify buildは行っていない。

2026-08-30に修正済みstate inspectorを1回実行し、INITIAL/MANUAL SyncRun 6件をread-only取得した。状態はSUCCESS 5件（INITIAL 3 / MANUAL 2）、FAILED 1件（MANUAL 1）で、FAILEDのerrorCodeは`SUBSCRIPTION_PAUSED`だった。出力は許可された状態項目のみで、DBは`count`/`findMany`以外の操作を行っていない。確認後に`pnpm staging:sleep`を実行し、API 0/0/0、RDS `STOPPED`、Worker Scheduler `DISABLED`、Cloud Map登録0、status `SLEEPING`へ復旧した。

2026-08-30に限定scope（`calendar.app.created`）で行った直前の手動Syncをread-onlyで最終監査した。対応するWorker taskはexit code `0`で終了し、terminal summaryは`total=1 / success=1 / skipped=0 / deferred=0 / failed=0`だった。targeted manual runは、`syncSubscription`が`finishSyncRun(..., 'SUCCESS')`を完了してからSUCCESSをWorkerへ返すため、この結果をもって対象SyncRunの終端SUCCESSを確認した。対象時間帯のWorker/APIログにCalendar scope・permission、Calendar API、YouTube API、同期失敗のイベントはなく、sync queue、sync DLQ、Worker Scheduler DLQはすべて`0/0/0`、Pipeは`RUNNING`だった。決定的event ID・既存mapping/hash一致時skip・409時patchの同期契約と今回のエラーなしの結果から重複生成の兆候はない。Google Calendar実イベント一覧の独立照会はこのread-only監査の対象外である。

同日、限定scope手動Syncの受入完了後に承認済み`pnpm staging:sleep`を実行した。APIは`0/0/0`、RDSは`STOPPED`、Worker Schedulerは`DISABLED`、sync queue・sync DLQ・Worker Scheduler DLQはすべて`0/0/0`となり、最終statusは`SLEEPING`である。追加のSync、Worker、OAuth、Calendar操作は行っていない。

2026-08-30にHigh 2対応として、Google OAuth開始前（初回ログイン・再連携）に、`calendar.app.created`の用途を専用カレンダーと配信予定の作成・更新・削除に限定して説明するUIを追加した。既存カレンダーを読み取らないことも明示している。Googleボタンは白背景、標準境界線、黒文字、Roboto系font、ローカライズ済み`Google でログイン`文言のブランド準拠スタイルへ統一した。Terms/Privacy本文、AWS、Google/Supabase設定は変更していない。関連UIコピーtest、Web lint、typecheckは成功した。

2026-08-30にHigh 2のTerms/Privacyを正式化した。`/terms`と`/privacy`からデモwarning・未定の問い合わせ先を除き、運営者「推しスケジュール運営者」、問い合わせ先`oshi.schedule@gmail.com`、制定日・最終更新日を表示した。Google user dataの取得・利用・暗号化保存・委託先・国外取扱いの可能性・人によるアクセス・Limited Use、広告/販売/AI学習への不使用、削除手続、実装済みのSyncRun通常90日・productionログ30日保持を実装と照合して記載した。production backupの実保持期間と削除墓石の削除SLA、対象地域・料金・準拠法・管轄、専門家確認は未解決のHigh 2 blockerとして残る。AWS、Google/Supabase外部設定、OAuth審査は変更していない。関連UI test、Web lint、typecheckは成功した。

2026-08-30にTerms/Privacyの技術事項をIaC/Prismaと再照合した。RDS自動backupは`rdsBackupRetentionDays`で、未指定時1日、`deleteAutomatedBackups=false`、production deletion protection・暗号化・非公開サブネットを使用する。運用文書のproduction 7日/PITRは目標値で、現行IaCはproduction専用値やPITR、手動snapshot自動削除期限を強制しない。アカウント削除では利用者専用User関連を削除し、共有YouTubeデータは残る。SyncRunは利用者関連を外して残り、通常90日メンテナンスで削除される。削除墓石は自動purgeも完了SLAもなく、API/Worker/HTTP API/RDSログはproduction 30日、staging 14日である。RDS backupは通常データ削除と同時に消えず、retention経過後に失効する。production最終backup/PITR値、snapshot/墓石SLA、地域・料金・準拠法・管轄、法的確認は引き続き運営判断事項である。AWS write、deploy、外部設定変更は行っていない。

2026-08-30に承認済みproduction保持・運営方針をコードと文書へ反映した。production IaCは`rdsBackupRetentionDays=7`を必須とし、7日以外をsynth前に拒否する。production RDSは7日backup/PITR、`deleteAutomatedBackups=false`、deletion protection、暗号化、private subnetを維持する。手動snapshotはdeploy recordへ削除期限（30日以内）と担当者を記録し、例外保持には理由・承認者・見直し日を必要とする。完了済みAccountDeletionRequestは定期Workerのmaintenanceで完了から30日超後にpurgeし、未完了・失敗状態は既存の安全な再試行のため保持する。SyncRun 90日、production log 30日を維持する。Terms/Privacyへ日本国内向け、現時点無料、将来有料化時の事前料金表示・規約・必要な法令対応、日本法、東京地方裁判所、法令上必要な例外保持を反映した。AWS write、deploy、外部設定変更は行っていない。

2026-08-30にproduction公開設定を設計・実装した。production Webは`https://oshi-schedule.com`、APIは`https://api.oshi-schedule.com`に固定し、IaC validationとproduction deploy workflowが別URLを拒否する。root Web domainのAmplify Domain Associationは`Prefix: ''`を使い、CDKが`WEB_ORIGIN=https://oshi-schedule.com`と`NEXT_PUBLIC_API_URL=https://api.oshi-schedule.com`を生成する。Termsとlogin画面へ13歳未満利用不可を反映した。Google Cloud/Supabaseのproduction分離、URL matrix、scope justification、demo video、verification、最終受入を[production公開チェックリスト](production-release-checklist.md)へ手順化した。AWS、Google、Supabaseへのwrite・deploy・verification申請は行っていない。

2026-08-30にproduction AWS投入前のread-only preflightを行った。専用`oshi-schedule` profileはaccount `741448960817`、region `ap-northeast-1`で本人確認でき、公開Route 53 hosted zone `oshi-schedule.com`は存在する。一方、production CloudFormation stack、production API ACM certificate、production Amplify App、`oshi-schedule-production/`配下のSecrets Manager Secret、`/oshi-schedule-production/`配下のSSM Parameterはいずれも未作成だった。外部作成が必要なのは4つのapplication Secretと`allowed-emails` SecureStringだけで、Supabase URL／Google Client ID、Web origin、Amplify public environment、RDS managed credentialはCDKが生成・参照する。値を取得せず、Secret名とARN/Parameter型だけで確認する安全手順を[production公開チェックリスト](production-release-checklist.md)へ追加した。直近mainのGitHub CIはvalidate（Unit/MySQL integration）とe2eがfailureだが、job log downloadはGitHub API 403で原因未取得である。production投入前にCI greenを確認する必要がある。AWS write、deployは行っていない。

2026-08-30にproduction deploy blockerのCI失敗を調査した。Actions APIでは`614a8cd`以前のvalidate/e2e失敗を確認し、ログdownloadは403だった。ローカルのsandboxでは`supertest`が`0.0.0.0`へlistenできないEPERMで失敗するが、sandbox外で同じvalidate commandを実行すると通過したため、これはGitHub Ubuntu runnerの失敗原因ではない。最初に`scripts/aws/staging-context.test.mjs`の旧runtime digest固定を承認済みdigestへ更新したが、修正commit `2c84501`のActions annotationで残存failureを特定した。原因は`infra/test/oshi-schedule-stack.test.ts`のECR-first bootstrap synth testがGitHub Ubuntu runnerで既定5秒を超えることだった。CDK synthとresource assertionの内容は維持し、当該重いtestだけに15秒の明示timeoutを設定した。E2Eには、Terms/Privacy正式化後の廃止済みデモ文言と、Google branding対応後の旧ボタン名という2つの期待値driftがあった。正式なTerms本文の13歳以上利用条件と`Google でログイン`のaccessibility nameを検証するよう更新し、正式文面・Google branding・業務実装は変更していない。ローカルでinfra test（109件）、typecheck、lint、Playwright E2E（9件）が成功した。ローカルDockerの容量不足によりMySQL integration DBの新規作成はできず、GitHubのvalidate/e2e green確認をproduction投入の最終gateとする。AWS write、deployは行っていない。

2026-08-30に承認済みproduction投入前writeを再開した。`api.oshi-schedule.com`のACM証明書を作成し、公開Route 53 hosted zoneへDNS検証CNAMEを追加した。証明書は`ISSUED`、DNS validationは`SUCCESS`である。production application Secret 4件（Supabase service-role、Google client secret、YouTube API key、CSPRNG生成のtoken encryption keys）は存在を名前だけで確認した。値の取得・表示は行っていない。`/oshi-schedule-production/runtime/allowed-emails` SecureStringは未作成であり、非表示対話入力から値を取得できない限り空値・staging値で作成しない。残存入力processはない。

最新main `30b3c57`のCIはvalidate/e2eともgreenで、production container buildと`.trivyignore`によるproduction scanも成功している。一方、stagingで現在使用するimmutable digestはstaging限定CVE例外7件を含み、production promotion workflowが拒否する。production用ECR repositoryと昇格可能なimmutable digestは未作成である。current HEADのlocal linux/amd64 candidate buildはDocker内部容量不足（ENOSPC）で完走せず、既存cache/imageを承認なく削除しなかった。production Supabase URL、publishable key、Google Client ID、alert email、production適格digestが未入力のため、production CDK preflight/diffは未実行である。Stack/Amplify/ECS/RDS deployは行っていない。

2026-08-30にproduction allowed-emailsをread-only再確認した。`/oshi-schedule-production/runtime/allowed-emails`は存在し、型は`SecureString`、内容は非空のカンマ区切りメール形式として妥当だった。値自体は取得・表示・保存せず、AWS writeも行っていない。

2026-08-30にproduction deploy直前のimage経路をread-only再確認した。最新mainのCIはproduction imageをbuild・runtime contract・Trivy scanするがECRへpushしない。production promotion workflowはstagingで稼働中のdigestを唯一の入力とし、production ECR repositoryへmanifestを昇格する。この時点でproduction ECR repositoryはCDK管理で未作成、stagingの現行digestはstaging限定CVE例外7件を含むためpromotion workflowが明示的に拒否する。新しいproduction適格candidateのlocal linux/amd64 buildはDocker内部容量不足で失敗済みであり、現在も未使用build cache 15.24GB、未使用image 19.67GBがreclaimableだが、承認なく削除しない。AWS write、image push、production deployは行っていない。

2026-08-30に承認済み範囲でDocker build cacheだけを0Bまで削除し、image・volume・containerには触れなかった。最新mainからlinux/amd64 production candidateをbuildし、runtime contract（non-root、Node.js 22.23.1、Prisma、RDS CA）を確認した。ローカルTrivy CLIは未導入で、Docker socketまたはimage payloadを第三者scanner containerへ渡す代替は安全審査で拒否されたため、ローカルproduction scanは未完了である。staging限定CVE例外7件はproduction `.trivyignore`に含まれず、現行staging digestは引き続きpromotion不可である。

productionの最初のECR作成はCDK `bootstrapOnly=true`を唯一の所有者にする。bootstrap phaseがVPCを作成していたため、Repositoryだけを作成してreturnするようIaCと回帰testを更新した。実accountのbootstrap diffは`AWS::ECR::Repository` CREATE 1件だけである。full production synthは提供済みのproduction-only public context、4つのcomplete Secret ARN、SecureString、ACMを用いてboundary guardを通過し、RDS backup 7日とlog retention 30日を確認した。実digest未確定のためlocal candidate内容IDを構造確認専用に使ったfull diffは新規stack CREATE 98件、DELETE/REPLACE 0件だった。template内のstaging ARNはGitHub production promotion roleに付与したstaging ECR/ECSのread-only検証権限だけで、runtime configurationにはstaging参照がない。production ECR bootstrap deploy、image push、full production deployはいずれも未実行である。

2026-08-30に承認済みproduction ECR bootstrapを実施した。直前CDK diffは`AWS::ECR::Repository` CREATE 1件、VPC/ECS/RDS/Amplify/Route 53のCREATE 0件、DELETE/REPLACE 0件だった。`oshi-schedule-production` stackは`CREATE_COMPLETE`となり、実resourceはCDK metadataとimmutable・scan-on-push有効な`oshi-schedule-production` ECR Repositoryだけである。deploy後CDK diffは0。最新main `c69d9ac`のGitHub Actions CIはvalidate/e2eともsuccessで、validate内のproduction container build、runtime contract、Trivy scanもsuccessだった。CIはimageをECRへpushしないためdigestは未確定である。次の別承認AWS writeは、current mainから再現したlinux/amd64 imageをimmutable `c69d9ac` tagでproduction ECRへpushし、scan-on-push完了後にECR digestを固定すること。その後に実digestでfull production CDK diffを再実行する。production Stack/Amplify/ECS/RDS deployは行っていない。

2026-08-30にCI成功済みHEAD `37377ad`からlinux/amd64 imageを再現し、runtime contractを確認してproduction ECRへimmutable tag `37377ad`でpushした。digestは`sha256:95a3c5378ae8c4c223116a6f4090ccea62676bd378e40846aeb0fd4516c5cec1`である。ECR Basic Scanは`COMPLETE`だったが、staging限定例外7件（`CVE-2026-12087`、`CVE-2026-48959`、`CVE-2026-48961`、`CVE-2026-54874`、`CVE-2026-63072`、`CVE-2026-63076`、`CVE-2026-7017`）を検出した。これらはproduction `.trivyignore`に含まれず、productionへ流用できない。そのため例外追加、full production preflight/CDK diff、full deployは行わず停止した。

2026-08-30に上記production imageのCI Trivy成功とECR Basic Scanの差異を再調査した。ECRで検出した7件は、`perl` source package `5.36.0-7+deb12u3`のCRITICAL 1件（`CVE-2026-12087`）とHIGH 3件（`CVE-2026-48959`、`CVE-2026-48961`、`CVE-2026-7017`）、`openssl` `3.0.20-1~deb12u2`のHIGH 3件（`CVE-2026-54874`、`CVE-2026-63072`、`CVE-2026-63076`）だった。fresh DBのTrivyでもこの7件は検出されず、根因はTrivyとECR Basic Scanの脆弱性データソース差である。CIとproduction promotion workflowは`cache: 'false'`を明示してTrivyのDB再利用を防ぎ、production `.trivyignore`だけを使うfresh DBのHIGH/CRITICAL gateへ固定した。さらにpromotionはECR Basic Scanの全pageを読み、production例外以外のCritical/Highを1件でも拒否する。policy validatorと回帰testはこの契約を検査する。

最新の`node:22.23.1-bookworm-slim`とBookworm apt候補には修正版がなく、TrixieはOpenSSL/Perlを更新する一方、fresh Trivyで未承認HIGH 4 IDを導入したため不採用とした。Node.js 22.23.1を保つ公式digest固定の`node:22.23.1-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2`（Alpine 3.24）へruntime baseを変更したlocal candidateは、OpenSSL `3.5.8-r0`、Node.js 22.23.1、non-root、Prisma generated/importable/constructable、RDS CA、API/Worker/Migration entrypoint contractを満たした。公式配布物のSHA-256を照合したTrivy 0.73.0とfresh DBによるproduction policy scanはCRITICAL 0 / HIGH 0である。candidateはローカルのみで、ECR push、AWS deploy、AWS設定変更は行っていない。次の別途承認writeは、このcommit由来candidateをproduction ECRへimmutable tagでpushし、ECR Basic ScanのCOMPLETEと未承認CRITICAL/HIGH 0を確認すること。

2026-08-30にHEAD `951cc81`由来のlinux/amd64 production candidateをimmutable tag `951cc81`でproduction ECRへpushした。確定digestは`sha256:99206b651bbcebd146c16894fb4f9f24036ec238b71959f10278d30dcd775daa`である。ECR Basic Scanは`COMPLETE`、finding総数0（CRITICAL 0 / HIGH 0）だった。全pageを読むproduction policy gateもPASSし、staging限定7件およびその他の未承認Critical/Highは0件である。ECR push/scan確認以外のAWS write、full production preflight/CDK diff、本体deploy、ECS/RDS/VPC/Amplify/Route 53/Secrets/SSMの変更は行っていない。gateの実AWSレスポンス構造対応は回帰testで固定し、次の工程は別途承認されたfull production preflight/CDK diffである。

2026-08-31にproduction初回deploy直前のfull preflightとCDK diffを実施した。account `741448960817` / `ap-northeast-1`、最新mainのCI success、`api.oshi-schedule.com` ACM `ISSUED`、production application Secret 4件、`/oshi-schedule-production/runtime/allowed-emails` SecureString、immutable image digest `sha256:99206b651bbcebd146c16894fb4f9f24036ec238b71959f10278d30dcd775daa`、ECR Basic Scan `COMPLETE`（CRITICAL 0 / HIGH 0）を値非表示で確認した。production boundaryはWeb `https://oshi-schedule.com`、API `https://api.oshi-schedule.com`、RDS backup/PITR 7日、production log retention 30日を満たす。full差分はbootstrap済みECRを維持してVPC、RDS、ECS/API、Queue/Pipe/Scheduler、API Gateway、Amplify、Route 53、監視等を新規作成する初回構成で、DELETE/REPLACEは0、runtime設定にstaging参照はない。template内のstaging ARNはGitHub production promotion roleのstaging ECR/ECS read-only検証権限だけである。production deployは実行していない。一般公開前にはGoogle Cloud/Supabaseのproduction URL matrix・provider・consent/verificationと、full deploy後のmigration・疎通・受入を別工程で完了する。

2026-08-31に現行production full deployを中止したまま、[production serverless低コスト移行設計](../architecture/production-serverless-low-cost.md)を完成した。推奨はAmplify、HTTP API→API Lambda、SQS→Worker Lambda、Scheduler→Worker Lambda、production Supabase Authと同一projectの非公開`app` schema上のPostgres Proである。RDS/ECS/VPC Link/Cloud Map/public IPv4はproductionで作成せず、Supabase Proのdaily backup 7日を使う。PITRは別途約100 USD/月のため初期案から外し、現行RPO 5分とPrivacy/runbookのPITR表現は実装前owner判断事項とした。低traffic見込みは合計約29〜35 USD/月。最大リスクはMySQL固有lease/quota/claim SQLのPostgreSQL化、Lambda 15分上限、Supavisor connection、Lambda横断rate limitであり、改修規模は15〜25 engineer-daysである。コード/IaC、AWS/Supabase、DBは変更していない。次はPhase 0のPro/backup/RPO方針承認後、PostgreSQL compatibilityから実装する。

2026-09-01に正式採用したSupabase Free + Lambda + S3日次backup 7日構成を実装した。Prisma datasourceをPostgreSQLの非公開`app` schemaへ切り替え、MySQL migrationを`prisma/migrations-mysql/`へ監査archiveとして移動し、新baseline、PostgreSQL lease/quota/claim SQL、serializable retry、Supavisor transaction URL（TLS、`pgbouncer=true`、`connection_limit=1`）validationを追加した。APIはAPI Gateway v2用Express Lambda adapter、WorkerはSQS batch 1/partial failureと1時間SchedulerのLambda handlerへ移行し、API-only Supabase service roleをWorker IAMから除外した。日次`pg_dump`はprivate S3の7日lifecycleとprotected GitHub OIDC workflowで実装し、restore runbookを追加した。production templateはRDS/ECS/VPC/VPC Link/Cloud Map/Pipe/Public IPv4を生成しない。既存legacy stagingの削除を防ぐため、serverless stagingは`oshi-schedule-staging-serverless` preview stackとして分離し、旧RDS/ECS/Amplify/domain/ECRを変更しない。Terms/Privacy、release checklist、architectureをFreeの最大RPO 24時間・Auth独自backup対象外・pause制約へ整合した。serverless deploy workflowはproduction Trivy gateを含む共通CIを必須にし、obsoleteなECR-only検証を要求しない。Docker runtime contractもRDS CA前提を除去し、Lambda互換Prisma engineを必須とする検証へ更新した。AWS/Supabase write、実DB migration、deployは未実施である。次の工程は、staging専用Supabase runtime/migrator URL Secret 2件とruntime roleを準備後に、preview stackへbaseline適用・受入すること。

2026-09-01にserverless preview初回deployはLambda account concurrent executions `10`に対しAPI `5`・Worker `1`のreserved concurrencyを作成しようとして失敗し、`oshi-schedule-staging-serverless`は`ROLLBACK_COMPLETE`となった。quota `50`へのService Quotas API申請は、AWSが既定値`1000`超を要求して受理しなかったため採用しない。templateはAPI/Workerのreserved concurrencyを除去し、WorkerをSQS event sourceのbatch size `1`・maximum concurrency `2`に限定した。SchedulerはWorker直接invokeをやめ、`{kind:"scheduled"}`を同じsync SQSへ送るため、initial/manual/periodicは同一のSQS retry/DLQ経路を使う。SyncLease claim/fencing、active run dedupe、決定的Calendar IDは最大2並列でも維持され、APIが一時的にaccount unreserved poolを使い切る場合はWorkerのSQS retryで回復する。HTTP APIの50 rps / 100 burst throttleとDynamoDB共有rate limitは維持する。

同rollbackで`oshi-schedule-staging-serverless-database-backups-741448960817`は`DELETE_SKIPPED`で残った。read-onlyでempty、SSE-S3、public access block、7日lifecycle、CDK tagを確認した。今後のstaging preview bucketはempty rollback時に`DELETE`となり孤児化を防ぐ。既存bucketは削除禁止であり、preview再作成時はfailed stack recordを削除（bucket retain）後、CloudFormation resource importで同bucketを`DatabaseBackupBucket`として再管理する別承認が必要である。legacy `oshi-schedule-staging`は`UPDATE_COMPLETE`のままで、今回の変更・失敗でUPDATE/DELETE/REPLACEはない。
