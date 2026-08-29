# staging handoff

長い状態説明を毎回プロンプトへ転記せず、この文書を引き継ぎの要約として使う。作業開始時の実状態は、AWS read-onlyの`pnpm staging:preflight`で必ず再確認する。

## 現在状態

2026-08-28 21:15 JSTに`oshi-schedule` profile、`ap-northeast-1`で再確認した。

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

2026-08-28 23:16〜23:20 JSTにAmplify `main`のjob `7`を1回だけ実行し、BUILD/DEPLOY/VERIFYすべて`SUCCEED`した。接続済みmainのHEAD（OAuth `calendar.app.created`最小scope実装を含む）をbuildし、`https://staging.oshi-schedule.com/`はHTTP 200で実アプリの識別表示を返し、Welcomeプレースホルダーではなかった。build中もAPI/RDSをwakeせず、完了後のstatusはAPI 0/0/0、RDS `STOPPED`、Scheduler `DISABLED`、`SLEEPING`である。OAuth実ログイン、Sync、wakeは行っていない。

2026-08-29の限定scope受入で、targeted Worker taskが起動直後に`ALLOWED_EMAILS`欠落でexit code 1となった。allowlistはHTTP APIの招待制認可だけで使用し、Workerの同期経路では使用しない。原因はAPI/Worker共通runtimeがAPI専用のallowlist必須validationを実行したことだった。未deployの修正ではruntime validationをAPI/Workerで分離し、APIのproduction/real allowlist必須契約を維持したまま、Workerはallowlistを注入せず起動可能にする。Task DefinitionのWorker/Migrationにallowlistを渡さない契約と、real-mode Worker起動、queued targeted SyncRunの次Worker起動時回復を回帰テストで固定した。

今回Pipeが起動したWorkerはruntime初期化前に停止したため、対象SyncRunはclaimされず`QUEUED`のまま残る。次の正常なWorker起動では`runPendingManual`がqueued targeted runを回収する。Worker Schedulerは通常`DISABLED`のため、deploy後は明示承認されたWorker実行またはScheduler一時有効化でこの既存runを1回だけ回復確認する。AWS/DB/Calendar write、image push、deploy、再Syncはこの調査・修正では行っていない。

2026-08-29にWorker env validation修正版（commit `e5eb939`）のcandidateをECRへpushし、digest `sha256:a8d9a7fa64246f6b035a1c551561de5678ee9c39830858dd058fcd46e239f1c1`でBasic Scanを再確認した。CRITICAL 3 / HIGH 9のうち、`CVE-2026-12087`、`CVE-2026-48959`、`CVE-2026-48961`、`CVE-2026-7017`は、既存の[ECR scanner-specific accepted CVEs](../security/container-vulnerability-exceptions.md#amazon-ecr-basic-scanning-specific-accepted-cves)に記録済みの`perl` source-package由来4件だった。`perl-base`は公式`node:22.23.1-bookworm-slim`に含まれるEssential packageであり、アプリが追加した依存ではない。runtimeには`Socket`だけが存在し、`IO::Compress`/`IO::Uncompress`、`HTTP::Tiny`、`zipdetails`は存在せず、API/Worker/entrypointもPerlを起動しない。特にCVE-2026-48961について、Debianの`libio-compress-perl`はbookwormでnot-affectedだが、ECRはsource package `perl`へ広く紐付けて報告しているため、画像内の実module不在と矛盾しない。bookwormには4件の適用可能な修正版がないため、Essential packageの強制削除やbase OS変更は最小・安全な修正ではない。既存例外の期限（2026-09-11）までの受容条件・production promotion前の再審査を維持する。今回新しい例外、Dockerfile変更、AWS writeは行っていない。

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

今回のOAuth/login、チャンネル登録、再Sync、削除、再登録、定期Scheduler同期の受入、バックエンド監査、staging sleep、リリース前最終監査は完了した。招待制stagingは技術的受入完了で`SLEEPING`を維持する。production公開設定guardとOAuth scope最小化コードは解消済みで、一般公開へ残るHighは[High 2詳細監査](../reviews/high-2-production-oauth-legal-audit.md)の限定scope実受入、法務表示、branding、production外部設定・公開審査である。次は新runtime candidateのECR固有OpenSSL 3件について、2026-09-11までの期限付き例外を明示承認するか判断する。承認後に限定deployを再開し、その完了後、Google/Supabase Data Access変更と旧grantを排除したstaging手動受入を別途承認の上で行う。
