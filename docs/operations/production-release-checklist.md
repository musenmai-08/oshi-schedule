# production公開チェックリスト

> 2026-09-06 post-deploy監査: release SHA `3c23218ca95ddc1cc0523ad5a87e3f9a091465b6` のdeploy runは成功し、CloudFormation/Lambda/API/Queue/Alarm/DB接続は正常。Amplifyはdetached App-only（repository/Branch/Domainなし）である。ローカル再synthではLambda Code 2件の差分が残るため、完全なpost-deploy CDK diff 0は未達であり、bundle再現性を公開前に確認する。

2026-09-06更新: `a9a5cf1`のproduction detached redeployでPrisma engine差異を解消し、変更はAPI/Worker Lambda Codeのみ。CloudFormation、API疎通、Queue/DLQ、ESM、alarms、Scheduler、DB migration/runtime接続は正常。Amplify App-only detached（repository/Branch/Domainなし）で、GitHub repository接続が次工程。

この手順はproduction公開前の設計・受入用である。AWS、Google Cloud、Supabaseの設定変更およびverification申請は、各工程で別途承認を得てから行う。Secret値、token、OAuth code、個人情報をdeploy recordやissueへ記録しない。

> 2026-09-01に[serverless低コスト移行設計](../architecture/production-serverless-low-cost.md)を正式採用した。ECR-first/RDS/ECSの記録は履歴であり、新しいdeploy承認には使わない。productionはSupabase Free + Lambda + S3日次backup 7日である。

> 2026-09-06にGitHub deploy identity、Amplify repository接続phase、backup OIDC subject、migration/deploy分離、migration-aware backup契約をコード/IaCで解消した。これらのIAM/Appを作るAWS deployは未実施である。DB Secret/runtime role/baselineと外部公開gateが残るためproduction deployは禁止を継続する。

## 確定した公開URLとアプリ設定

| 用途                      | 値                                                                       | source of truth                                       |
| ------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------- |
| Web origin / homepage     | `https://oshi-schedule.com`                                              | `webDomainName`、`WEB_ORIGIN`                         |
| Web callback              | `https://oshi-schedule.com/auth/callback`                                | Web OAuth `redirectTo`、Supabase Redirect URLs        |
| Terms                     | `https://oshi-schedule.com/terms`                                        | Web route、Google consent screen                      |
| Privacy                   | `https://oshi-schedule.com/privacy`                                      | Web route、Google consent screen                      |
| API origin                | `https://api.oshi-schedule.com`                                          | `apiDomainName`、`NEXT_PUBLIC_API_URL`                |
| Google OAuth redirect URI | `https://<production-supabase-project-ref>.supabase.co/auth/v1/callback` | production Supabase Google provider画面に表示される値 |

production IaCはWeb domainを`oshi-schedule.com`、API domainを`api.oshi-schedule.com`に固定する。Amplify Domain Associationはroot domainとして`Prefix: ''`を使う。`WEB_ORIGIN`と`NEXT_PUBLIC_API_URL`はCDKが上表から生成し、productionでstaging/development/placeholder値はvalidationで拒否する。

## Google Cloud / Supabaseの分離方針

- stagingとproductionでSupabase project、Google Cloud project、Google OAuth Web client、client secret、Supabase publishable key、service-role secret、token encryption key、YouTube API keyを共有しない。
- production Google OAuth clientにはproduction Supabase callbackだけを登録する。アプリの`/auth/callback`をGoogleのredirect URIとして登録しない。
- production Supabase AuthはSite URLとRedirect URLsをproduction Webだけに限定する。staging、localhost、preview wildcardをproduction allowlistへ追加しない。
- production OAuthは`openid`、`https://www.googleapis.com/auth/userinfo.email`、`https://www.googleapis.com/auth/userinfo.profile`、`https://www.googleapis.com/auth/calendar.app.created`だけを要求する。広い`calendar` scopeを登録・許可しない。

## AWS投入前のSecret・Parameter境界

productionの値はstagingからコピーしない。production用Supabase project、Google Cloud projectと、それぞれで新規発行した値だけを使う。`ALLOWED_EMAILS`はproductionで独立して管理するSecureStringであり、同じ利用者を許可する場合もstaging値を自動コピーしない。

### CDK deploy前に外部作成する項目

| 種別             | AWS名                                                    | 注入先            | 値の提供元                                           |
| ---------------- | -------------------------------------------------------- | ----------------- | ---------------------------------------------------- |
| Secrets Manager  | `oshi-schedule-production/app/supabase-service-role-key` | API               | production Supabase service-role key                 |
| Secrets Manager  | `oshi-schedule-production/app/google-client-secret`      | API・Worker       | production Google OAuth client secret                |
| Secrets Manager  | `oshi-schedule-production/app/youtube-api-key`           | API・Worker       | production Google Cloud projectのYouTube API key     |
| Secrets Manager  | `oshi-schedule-production/app/token-encryption-keys`     | API・Worker       | production専用のCSPRNG生成鍵                         |
| Secrets Manager  | `oshi-schedule-production/app/database-runtime-url`      | API・Worker       | Supavisor transaction URL、TLS、`connection_limit=1` |
| Secrets Manager  | `oshi-schedule-production/app/database-migration-url`    | migration・backup | direct IPv6またはSupavisor session URL               |
| SSM SecureString | `/oshi-schedule-production/runtime/allowed-emails`       | APIのみ           | productionで許可するメールアドレスのカンマ区切り     |

`TOKEN_ENCRYPTION_KEYS`は`key-id:32-byte-base64`形式とし、先頭を新規暗号化用、後続を旧ciphertext復号用にする。production初回は新しい32-byte CSPRNG鍵だけを設定する。runtime DB roleは`app` schemaのDMLだけ、migration roleはDDL ownerとし、同じURLを使わない。

### CDKが生成するため事前作成しない項目

- Amplify環境変数: `WEB_ORIGIN`、`NEXT_PUBLIC_API_URL`、`NEXT_PUBLIC_DEMO_MODE=false`、`NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- Lambda、SQS/DLQ、DynamoDB rate-limit table、Scheduler、HTTP API、S3 backup bucketと最小権限role

### ECR-first bootstrap

production ECR repositoryはCDKの`bootstrapOnly=true` phaseが唯一の所有者として作成する。最初のdeployではECR Repositoryだけを作成し、VPC、RDS、ECS、Amplify、Route 53などのfull-stack resourceは作成しない。repository名をAWS CLIやConsoleで手動作成してCloudFormation ownershipと衝突させない。

1. production専用の非秘密contextと`confirmProduction=DEPLOY_PRODUCTION`を使い、`bootstrapOnly=true`のCDK diffが`AWS::ECR::Repository` CREATE 1件だけであることを確認する。
2. このbootstrap deployを別途承認後に実施し、CloudFormationが`UPDATE_COMPLETE`、ECR repositoryがCDK管理で存在することだけを確認する。
3. production policyを通過したimageをimmutable digestでpushする。staging限定CVE例外を含むimageはpromotion・push対象にしない。HEAD `951cc81`由来の検証済みcandidateは`sha256:99206b651bbcebd146c16894fb4f9f24036ec238b71959f10278d30dcd775daa`としてECR Basic Scan（Critical 0 / High 0）まで確認済みである。
4. CIとpromotion workflowのTrivy gateは`cache: 'false'`でfresh vulnerability DBを使い、production `.trivyignore`だけを適用してHIGH/CRITICALを0件にする。push後はECR Basic Scanも`COMPLETE`まで待ち、同じproduction policyで未承認Critical/Highが0件であることを確認する。
5. そのdigestとfull production contextでCDK diffを確認し、full production deployは別途承認する。

2026-08-31のECS/RDS full diffは失効した。serverless実装ではbootstrap済みECR Repositoryを保持するがLambdaはimageを参照しない。新しいfull diffでRDS/ECS/VPC/VPC Link/Cloud Map/Pipe/Public IPv4が0件、DB URL Secret 2件を含む境界、S3 lifecycle 7日、production Log Group 30日を再確認する。

`SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`、`GOOGLE_CLIENT_ID`は秘密ではないが、production専用値をCDK contextへ渡す。`SUPABASE_SERVICE_ROLE_KEY`、`GOOGLE_CLIENT_SECRET`、`YOUTUBE_API_KEY`、`TOKEN_ENCRYPTION_KEYS`、`ALLOWED_EMAILS`の値はCDK context、Amplify、GitHub Variables、Git、shell引数へ渡さない。

### 安全な投入と確認

1. 値はpassword managerなどから、`set +x`の対話shellで標準入力または保護された一時fileへだけ渡す。CLI引数、環境変数export、履歴、deploy recordへ書かない。
2. Secret作成・更新後は`aws secretsmanager describe-secret`で**名前とcomplete ARNだけ**を確認し、`GetSecretValue`をpreflightに使わない。complete ARN（6文字suffix付き）はCDK contextにだけ渡す。
3. `ALLOWED_EMAILS`はSecureStringとして作成後、`aws ssm describe-parameters`で名前と型だけを確認する。値取得や`--with-decryption`は不要である。
4. customer managed KMS keyを選ぶ場合だけ、Lambda roleへの最小`kms:Decrypt`権限をCDK diffで追加確認する。AWS managed keyでは追加しない。
5. production contextはGit管理外の短命なローカル入力に限定し、secret値を含めない。実deploy前にIaC validation、Secret ARNのaccount/region/name/suffix検証、staging fingerprint拒否を通す。

## ユーザーが行う外部管理画面作業

### 1. 公開前のdomain・Web確認

1. `oshi-schedule.com`と`api.oshi-schedule.com`のDNS管理権限を確認する。
2. 承認済みAWS production deploy後、両URLのTLS証明書、有効なdomain関連付け、Web/API到達を確認する。
3. 認証なしでhomepage、`/terms`、`/privacy`がHTTPS 200で表示され、リンク・運営者・問い合わせ先・13歳未満利用不可の表示が一致することを確認する。

### 2. Google Cloud Console

1. production専用Google Cloud projectを作成し、Google Calendar APIを有効にする。
2. Google Auth PlatformでAudience、branding、developer contact、support emailを設定する。app name、logo、homepage、Terms、Privacyは公開URLと一致させる。
3. Authorized domainsへ`oshi-schedule.com`を登録し、Search Consoleのdomain所有権を同じ運営主体で確認する。
4. Web application OAuth clientを作成し、Authorized JavaScript originsへ`https://oshi-schedule.com`だけを登録する。
5. Authorized redirect URIsへproduction Supabase Dashboardが表示する`https://<production-supabase-project-ref>.supabase.co/auth/v1/callback`だけを登録する。
6. Data Accessへidentity 3 scopeと`calendar.app.created`だけを登録する。scope分類を記録し、不要な旧`calendar`、staging、localhostのclient/origin/redirectをproduction projectから除く。
7. Google provider用Client ID/Client Secretをproduction Supabase Dashboardへだけ設定する。Secretはチャット、Git、環境変数ファイル、deploy recordへ転記しない。

### 3. Supabase Dashboard

1. production専用Supabase projectを作成し、production以外のproject/keyを再利用しない。
2. Authentication > URL ConfigurationでSite URLを`https://oshi-schedule.com`に設定する。
3. Redirect URLsへ`https://oshi-schedule.com/auth/callback`を完全一致で追加する。wildcard、staging、localhostはproductionに追加しない。
4. Authentication > Providers > GoogleでGoogle providerを有効化し、直前に作成したproduction Client ID/Secretだけを設定する。
5. production project URL、publishable key、service-role secretをAWS productionの承認済みSecret/SSM投入手順へ渡す。service-role secretをWeb/Amplifyの`NEXT_PUBLIC_*`へ設定しない。

### 4. Google OAuth verification提出

1. homepage、Terms、Privacyが同じverified domainで公開済みであることを確認する。
2. scope justificationに、利用者ごとのアプリ作成専用secondary Calendarの作成と、そのcalendar内の配信予定eventのget/insert/patch/delete、account削除時のcalendar deleteだけに使うことを記載する。既存calendar一覧、free/busy、共有設定、primary calendarを読まないことを明記する。
3. demo videoを用意する。Google login、consent screenの限定scope、`/auth/callback`、onboarding、専用calendar作成、配信予定の作成・更新・削除、再認証とaccount削除を、tokenや個人情報を伏せて示す。
4. consent screen上のapp name/logo、support/developer contact、homepage、Terms、Privacy、authorized domain、scopeと実装を照合してから、必要なbrand/data-access verificationを申請する。
5. verification完了の証跡、scope分類、提出したvideo/justificationの版をrelease recordへ記録する。

## production deploy前の完了条件

- [ ] production CDK synth/diffでWeb=`oshi-schedule.com`、API=`api.oshi-schedule.com`、Amplify root-domain Prefix空、`WEB_ORIGIN`、`NEXT_PUBLIC_API_URL`が一致する。
- [x] serverless production contextでfull CDK preflight/diffを実行し、bootstrap済みECRとinfra/migration OIDC roleを維持、RDS/ECS/VPC/Pipeが0、DELETE/REPLACEがないことを確認する（full detached diffはCREATE 42）。
- [ ] mainの最新commitでGitHub Actions `validate`と`e2e`がともにgreenであり、workflow logで失敗がない。
- [ ] Lambda ZIPにPrisma Client/engineが含まれ、API/Worker handler contractがgreenである。ECR imageはrollback資産でありruntime deploy gateではない。
- [ ] production専用Secret/SSM/Google/Supabase値が揃い、staging由来値・localhost・placeholderがない。
- [ ] Google ConsoleとSupabaseのURL matrixが上表どおりで、production redirect allowlistは完全一致である。
- [ ] Google consent screen、scope justification、demo video、必要なverificationが承認済みである。
- [ ] Terms/Privacyの専門家確認、13歳未満利用不可、日本国内向け、無料/有料化方針、運営者・問い合わせ先の最終承認がある。
- [x] S3 app-schema日次backup 7日、最大RPO 24時間、Supabase Auth独自backupなし、Free pause、SyncRun 90日、log 30日、完了墓石30日purgeの責任者と復元演習が確認済みである。2026-09-11のproduction backup run `34603673493` は成功し、SSE-S3/private/7日Lifecycleのdump+manifest pairを隔離PostgreSQL 17へ復元して、`app` schemaとmigration stateの三者照合を完了した。
- [x] `database-migration-url`と`database-runtime-url`をproduction専用値で作成した。`app._prisma_migrations`はbaseline checksum一致で、`oshi_runtime`はapp業務tableのDMLだけを持ち、schema/database CREATE、role管理、migration metadata DMLを拒否する。
- [x] production infra/migration roleをrepository immutable-ID subjectと別GitHub EnvironmentでIaC化・AWS作成した。Amplify/backup roleはfull detached deployで作成する。
- [x] production AmplifyをApp-only (`detached`) → guarded repository接続 → Branch/Domain (`connected`)に分割し、未接続AppでBranch/Domainを作らない。
- [x] production backup roleをimmutable repository-ID subjectの`production-backup`だけがassumeできる契約へ統一した。
- [x] `migrate-production.yml`と`deploy-production.yml`を別承認にし、deployは同一commitの成功migration run/attestationなしでは進めない。
- [x] backupをdump + Git commit/migration ID/checksum manifestの一組とし、restore rehearsalで復元DBを機械照合する契約を実装した。実production backup/restore rehearsalはdeploy後に実施する。

## 最終受入手順

1. production deploy後、`https://oshi-schedule.com/`、`/terms`、`/privacy`、`https://api.oshi-schedule.com/health`、`/ready`がHTTPSで成功することを確認する。
2. 旧grantを持たない13歳以上の専用テストGoogleアカウントでloginを開始し、Googleのredirect URIがSupabase callback、アプリへのreturn先が`https://oshi-schedule.com/auth/callback`であることを確認する。
3. consent screenがidentity scopeと`calendar.app.created`だけを表示し、広い`calendar`を表示しないことを確認する。
4. callback/onboarding後に、専用calendar create/reuse、event get/insert/patch/delete、手動・定期同期、再認証、subscription削除、account削除を管理されたテストデータで確認する。
5. DB、CloudWatch、Supabase/Googleの監査でtoken、OAuth code、メールアドレス、Calendar IDが不適切に出力されず、削除・retention・DLQ/alarmが方針どおりであることを確認する。
6. すべての証跡をrelease recordへ集約し、release approverがHigh 2をclosedにしてから一般公開する。

### 2026-09-11 production release final audit

OAuth正式公開（Audience `External` / `In production`、Branding公開、Data Access verification不要）はGoogle Cloud Consoleでユーザー確認済みとして記録した。AWS read-only監査では、Amplify App/repository、main Branch、`oshi-schedule.com`（AVAILABLE）、初回job、Web/API 200、保護API 401、Lambda Active、SQS/DLQ 0、ESM 1/2、alarms OK、DB migration up-to-date、Scheduler `rate(1 hour)`/`ENABLED`、backup run `34603673493`（SSE-S3/private/7日Lifecycle）を確認した。ACTIVE対象2件はCredential復号可能、`reauthRequired=false`、CalendarConnection ACTIVE、直近MANUAL/SCHEDULED SyncRun SUCCESSで、PAUSEDの旧duplicate Userは対象外である。

CloudFormation driftは、API Gateway access-log ARN末尾とAmplify root prefixのAWS正規化差異2件のみで、release blockerではない。Schedulerは`rate(1 hour)`/`ENABLED`、SNSは`AlertsEmailSubscriptionV3`がConfirmed 1・Pending 0である。接続に使用した`AMPLIFY_GITHUB_PAT` Environment Secretおよびclassic PATは削除・revoke済みである。
### Production Amplify repository接続（detached後・完了記録）

既存App `oshi-schedule-production-web`（App ID `d1v67c1ruct5nd`）がrepository/Branch/Domain未接続であることを確認してから、GitHub Environment `production-amplify` に必須reviewerを設定する。Variablesは `AWS_REGION=ap-northeast-1`、`PRODUCTION_AMPLIFY_CONNECTOR_ROLE_ARN=arn:aws:iam::741448960817:role/oshi-schedule-production-github-amplify-connect`、`PRODUCTION_AMPLIFY_APP_ID=d1v67c1ruct5nd`、Secretは短命PATを `AMPLIFY_GITHUB_PAT` として登録する。PATは `musenmai-08/oshi-schedule` のみに限定し、workflow `Connect production Amplify repository` の入力 `CONNECT_PRODUCTION_AMPLIFY` を一度だけ実行する。repository接続後はPATを破棄し、connected preflightを通した別承認のCDK deployでmain Branch→Domainを作成する。

2026-09-09に上記手順を完了した。Appは同一IDでGitHub repositoryへ接続され、`main` Branch 1件、`oshi-schedule.com` Domain Association 1件（`AVAILABLE`、main関連付け）となった。初回Amplify job `1` は BUILD/DEPLOY/VERIFY すべて `SUCCEED`、公開WebはHTTP 200である。接続に使用した短命PATはGitHub Environment SecretおよびGitHub個人設定から削除・revoke済みである。

### Scheduler正式稼働前の再認証確認

production Schedulerを`rate(1 hour)`で有効化する前に、全ACTIVE subscriptionの最新scheduled syncがSUCCESSであることを確認する。2026-09-10の受入では、1ユーザーの既存refresh tokenが現在の暗号鍵ではAES-GCM認証に失敗し、Google Calendar APIへ到達する前に4回`PARTIAL_FAILED`となった。対象ユーザーは再同意でcredentialを更新し、`reauthRequired`が解除されたこと、INITIAL/MANUALが成功することを確認してから、Schedulerを一時的に1回受入し、最終的に`rate(1 hour)`/`ENABLED`へ設定する。credential・Calendar mapping・Calendar eventを手動削除して回避してはならない。

### Scheduler正式稼働（完了記録）

2026-09-11に、到達不能な旧User所有のsubscription 1件を、Calendar mapping・Calendarイベントを変更せず`PAUSED`へ限定更新した。Scheduler対象から除外されたことを確認後、残るACTIVE対象だけで一時的な1分間隔のscheduled受入を1回実施した。SCHEDULED SyncRunはSUCCESS、Calendar phaseはSUCCESS、queue/DLQ 0、mapping重複0、API/Worker Errors・Throttles 0、Alarm全件OKだった。最終設定は`rate(1 hour)`/`ENABLED`である。旧UserのPAUSED subscriptionおよびmappingのcleanupは、この受入とは別の所有者・Calendar整合確認を伴う承認工程として残す。

### Production backup / restore rehearsal（完了記録）

2026-09-11にproduction backup workflow run `34603673493`の同一prefix dump/manifest pairを受入した。両objectは非0 byte、SSE-S3 (`AES256`)、private ACL/public access block、7日Lifecycleを満たす。manifestのGit commitとbaseline migration ID/checksumはrepository stateと一致した。productionから隔離した一時PostgreSQL 17で空の`app` schemaを作成してcustom dumpをrestoreし、`app._prisma_migrations`・manifest・repositoryを機械照合した。Supabase Auth schemaはcustom dump/restoreの対象外である。一時container/network/downloaded filesはrehearsal終了時に破棄し、production DB、Scheduler、Calendar、S3 backup objectは変更していない。

### 2026-09-12 production正式受入完了

productionの技術的正式受入を完了した。CloudFormationは`UPDATE_COMPLETE`、Web/API、OAuth/Calendar、直近MANUAL/SCHEDULED sync、backup/restore、Queue/DLQ、Lambda、Alarmを確認済みである。SNSは`AlertsEmailSubscriptionV3`がConfirmed 1・Pending 0、Schedulerは`rate(1 hour)`/`ENABLED`。CloudFormation driftはAPI Gateway access-log ARNとAmplify root prefixの既知正規化差異2件のみである。production release blockerは0件。旧duplicate UserのPAUSED subscription/mapping cleanupは任意の別承認作業として残す。
