# リリース前最終監査

- 実施日: 2026-08-26
- 対象: staging受入結果、仕様、Web/API/worker、AWS CDK、CI/CD、運用・security文書
- 制約: AWS read-only。deploy、scale、Scheduler変更、DB接続、OAuth/Sync再実行は行っていない。

## 判定

**招待制stagingの技術的受入は完了している。production一般公開はHigh 2件が残るため未準備である。**

stagingはWeb 200、callbackの正規origin redirect、実OAuth、チャンネル登録・削除・再登録、要求時Sync、Scheduler起動の定期Sync、Calendar連携を受入済みである。監査時の実状態はCloudFormation `UPDATE_COMPLETE`、Amplify connected/Domain `AVAILABLE`、API 0/0/0、RDS `STOPPED`、Pipe `RUNNING`、定期Worker Scheduler `DISABLED`、全Queue/DLQ 0、Alarm 0で、意図した低コストsleep状態だった。CDK phase2 diffは0である。

## 定期同期のsource of truth

定期同期は次の全箇所で **`rate(1 hour)`** に統一した。

| 層                     | 確認結果                                                       |
| ---------------------- | -------------------------------------------------------------- |
| 要件・README・同期設計 | `rate(1 hour)`                                                 |
| CDK `WorkerSchedule`   | `rate(1 hour)`                                                 |
| CDK assertion          | `rate(1 hour)`を固定                                           |
| staging AWS実設定      | `rate(1 hour)`、flexible window OFF、event age 3600秒、retry 2 |
| 運用文書               | `rate(1 hour)`                                                 |

auto-sleepも独立した`rate(1 hour)`だが、これは同期頻度ではなくstaging停止忘れ防止の確認間隔である。

## staging受入マトリクス

| 機能                        | 実装・設定                                                                    | staging受入          |
| --------------------------- | ----------------------------------------------------------------------------- | -------------------- |
| Google OAuth                | PKCE、offline、consent、Calendar scope、正規callback origin、Supabase JWT     | 成功                 |
| Credential/Calendar初期設定 | refresh tokenをAES-256-GCM暗号化、専用Calendarを冪等作成                      | 成功                 |
| handle解決・登録            | 不正形式、存在しないchannel、重複、3件上限を区別し、登録後jobを非同期dispatch | 成功                 |
| 削除・再登録                | 所有者の未来eventだけ削除し、途中失敗から再実行可能                           | 成功                 |
| 手動Sync                    | 202、active run再利用、5分cooldown、SQS/Pipes one-off worker                  | 成功                 |
| 定期Sync                    | Scheduler → one-off worker、2対象 success 2/failed 0                          | 成功                 |
| Calendar差分同期            | 決定的event ID、mapping/hash、404/410/取消復旧、title/description仕様         | エラー・重複兆候なし |
| Queue                       | managed encryption、main queue redrive 3回、DLQ 14日                          | 滞留なし             |
| Web                         | Amplify SSR、main、custom domain、callback                                    | 成功                 |

## security・運用確認

- SecretはDB credentialsと4つのapplication SecretをSecrets Manager、allowed emailをSSM SecureString、公開値をSSM String/Amplifyへ分離している。Secret値はCloudFormation output、Amplify、GitHub Actionsへ渡さない。
- IAMはOIDC subjectを`main`へ限定し、ECS/Pipes/Scheduler/PassRole/Secret取得を対象resourceとservice conditionへ絞る。AWS APIのresource-level制約がないDescribe/List/Registerだけ`*`を使う。
- RDSはisolated subnet、public access false、storage encrypted、TLS required、SG ingressはAPI/workerの3306だけ。staging実instanceもpublic false/encrypted/deletion protection trueだった。
- 公開経路はAmplify WebとTLS 1.2のAPI Gateway custom domainだけ。execute-api endpointは無効で、VPC Link SGからAPI 4000だけを許可する。`/health`と`/ready`は秘密を返さない。
- Sync Queue/DLQはSQS managed encryption、TLS必須policy、queue 4日/DLQ 14日、maxReceiveCount 3。Scheduler DLQも暗号化・14日だが、下記Mediumを残す。
- auto-sleepはstagingだけに存在し、期限切れ時にScheduler → API → RDSの順で安全側へ停止する。productionとbootstrap-onlyには作らない。
- 現在digestのECR CRITICAL/HIGHは全8件が期限付き例外台帳と一致し、新規IDはない。例外期限は2026-09-11である。
- `.env`と`apps/web/.env.local`はGit管理外で、追跡対象から秘密形式は検出されなかった。`localhost`、fake/demo、sample値はlocal/test/CI/exampleに限定され、production Webはplaceholder/demoを拒否する。

## 指摘

### Critical

0件。

### High

1. **production公開値のcross-environment guardが機械化されていない。** Secret ARNは`oshi-schedule-production/...`、account、region、complete ARNまで検証する一方、`webDomainName`、`apiDomainName`、certificate、Supabase URL/publishable key、Google Client IDは「存在する」ことしかproduction configで検証しない。staging値をproduction contextへ渡しても設定loaderだけでは拒否できず、文書上の二者確認に依存する。production presetのsource of truthと、staging hostname/project ref/client IDを拒否するsynth testを追加するまでproduction deployを開始しない。
2. **一般公開用OAuth・法務表示が未完了。** `/terms`と`/privacy`は画面上も開発用デモと明示し、問い合わせ先、保存期間、Google API Services User Data Policy/Limited Use確認が未確定である。さらに実装は全Calendarへ広く作用できる`https://www.googleapis.com/auth/calendar`を使用し、[Googleが案内する限定scope](https://developers.google.com/workspace/calendar/api/auth)の`calendar.app.created`での再同意・全Gateway操作を未検証である。staging/testing用途は維持できるが、production一般公開前に正式文面、連絡先、scope決定、[OAuth production readiness](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance)に沿ったGoogle Cloudのbrand/data-access review状態を確定する。

### Medium

1. **Worker Scheduler DLQだけTLS必須resource policyがない。** Sync QueueとSync DLQは`enforceSSL: true`だが、`SchedulerDeadLetterQueue`にはなく、AWS実policyにも`aws:SecureTransport` denyがない。SDK/service連携はHTTPSを使うものの、同じqueue security baselineへ揃えるIaC修正とassertion testが望ましい。
2. **API production設定に開発用既定値が残る。** `WEB_ORIGIN=http://localhost:3001`と`ALLOWED_EMAILS=developer@example.com`はproductionでも明示必須ではない。現行CDKは環境別SSMを必ず注入するためstagingは安全だが、CDK外起動や将来のtask定義欠落を起動時に拒否できない。production/realでは明示値とHTTPS originを要求するfail-fast testが望ましい。
3. **Container CVE例外の再審査期限が近い。** 期限付きで承認済みのDebian CVE 19 ID（Trivy 15、ECR High/Critical 8）は2026-09-11に失効する。現在はCI validationを通るが、期限前にbase image rebuild、fresh scan、Debian status確認が必要である。

## 未確認項目

- private RDS内の今回のSyncRun行と、Google Calendar実イベント一覧・件数の独立したread-only照合。API polling、worker exit 0、terminal summary、Calendar error 0、決定的ID実装から成功と重複兆候なしまでは確認済み。
- production AWS/Supabase/Google Cloud resource、Secret実値、OAuth verification、domain、backup/PITR、restore rehearsal、quota増枠、負荷試験。production環境はまだ構築・受入していない。
- `calendar.app.created`へscopeを縮小した場合の既存利用者再同意とCalendar全操作。
- 一般公開向け正式な利用規約・プライバシーポリシー・非公開問い合わせ窓口。

## 次工程

招待制stagingは現状のsleep運用で利用できる。production工程へ進む前にHigh 1のconfig/IaC guardを実装・回帰テストし、High 2のscope・OAuth審査・正式ポリシーを利用者判断で確定する。その後、production専用project/contextのread-only review、CDK synth/diff、初回2-phase rolloutの順に進む。
