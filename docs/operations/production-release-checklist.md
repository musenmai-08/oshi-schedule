# production公開チェックリスト

この手順はproduction公開前の設計・受入用である。AWS、Google Cloud、Supabaseの設定変更およびverification申請は、各工程で別途承認を得てから行う。Secret値、token、OAuth code、個人情報をdeploy recordやissueへ記録しない。

> 2026-09-01に[serverless低コスト移行設計](../architecture/production-serverless-low-cost.md)を正式採用した。ECR-first/RDS/ECSの記録は履歴であり、新しいdeploy承認には使わない。productionはSupabase Free + Lambda + S3日次backup 7日である。

> 2026-09-06の[production serverless最終preflight監査](../reviews/production-serverless-final-preflight.md)では、構造diffがCREATE 42、UPDATE/DELETE/REPLACE 0で、旧RDS/ECS/VPC系が0であることを確認した。ただしDB Secret/role、GitHub deploy identity、Amplify repository接続phase、backup OIDC subjectが未解消のため、production deployはまだ禁止である。

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

| 種別             | AWS名                                                    | 注入先      | 値の提供元                                       |
| ---------------- | -------------------------------------------------------- | ----------- | ------------------------------------------------ |
| Secrets Manager  | `oshi-schedule-production/app/supabase-service-role-key` | API         | production Supabase service-role key             |
| Secrets Manager  | `oshi-schedule-production/app/google-client-secret`      | API・Worker | production Google OAuth client secret            |
| Secrets Manager  | `oshi-schedule-production/app/youtube-api-key`           | API・Worker | production Google Cloud projectのYouTube API key |
| Secrets Manager  | `oshi-schedule-production/app/token-encryption-keys`     | API・Worker | production専用のCSPRNG生成鍵                     |
| Secrets Manager  | `oshi-schedule-production/app/database-runtime-url`       | API・Worker | Supavisor transaction URL、TLS、`connection_limit=1` |
| Secrets Manager  | `oshi-schedule-production/app/database-migration-url`     | migration・backup | direct IPv6またはSupavisor session URL          |
| SSM SecureString | `/oshi-schedule-production/runtime/allowed-emails`       | APIのみ     | productionで許可するメールアドレスのカンマ区切り |

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
- [ ] serverless production contextでfull CDK preflight/diffを実行し、bootstrap済みECRを維持、RDS/ECS/VPC/Pipeが0、DELETE/REPLACEがないことを確認する。
- [ ] mainの最新commitでGitHub Actions `validate`と`e2e`がともにgreenであり、workflow logで失敗がない。
- [ ] Lambda ZIPにPrisma Client/engineが含まれ、API/Worker handler contractがgreenである。ECR imageはrollback資産でありruntime deploy gateではない。
- [ ] production専用Secret/SSM/Google/Supabase値が揃い、staging由来値・localhost・placeholderがない。
- [ ] Google ConsoleとSupabaseのURL matrixが上表どおりで、production redirect allowlistは完全一致である。
- [ ] Google consent screen、scope justification、demo video、必要なverificationが承認済みである。
- [ ] Terms/Privacyの専門家確認、13歳未満利用不可、日本国内向け、無料/有料化方針、運営者・問い合わせ先の最終承認がある。
- [ ] S3 app-schema日次backup 7日、最大RPO 24時間、Supabase Auth独自backupなし、Free pause、SyncRun 90日、log 30日、完了墓石30日purgeの責任者と復元演習が確認済みである。
- [ ] `database-migration-url`と`database-runtime-url`をproduction専用値で作成し、`oshi_runtime`がapp schemaのDMLだけを持ちDDLを拒否する。
- [ ] production GitHub deploy roleをrepository immutable-ID subjectで作成し、`deploy-production.yml`がOIDCでassumeできる。
- [ ] production AmplifyをApp-only → repository接続 → Branch/Domainの順で作成し、manual Branchがrepository接続を阻害しない。
- [ ] production backup roleのOIDC subjectをrepository immutable-ID形式へ統一し、production-backup environmentからのSTSだけを許可する。
- [ ] baseline migrationとinfra deployを別の承認・結果記録に分け、deploy失敗時に適用済みbaselineから安全に再開できる。
- [ ] app schema backupでPrisma migration状態を復元判定する方法を確定し、一時PostgreSQLへのrestore rehearsalで確認する。

## 最終受入手順

1. production deploy後、`https://oshi-schedule.com/`、`/terms`、`/privacy`、`https://api.oshi-schedule.com/health`、`/ready`がHTTPSで成功することを確認する。
2. 旧grantを持たない13歳以上の専用テストGoogleアカウントでloginを開始し、Googleのredirect URIがSupabase callback、アプリへのreturn先が`https://oshi-schedule.com/auth/callback`であることを確認する。
3. consent screenがidentity scopeと`calendar.app.created`だけを表示し、広い`calendar`を表示しないことを確認する。
4. callback/onboarding後に、専用calendar create/reuse、event get/insert/patch/delete、手動・定期同期、再認証、subscription削除、account削除を管理されたテストデータで確認する。
5. DB、CloudWatch、Supabase/Googleの監査でtoken、OAuth code、メールアドレス、Calendar IDが不適切に出力されず、削除・retention・DLQ/alarmが方針どおりであることを確認する。
6. すべての証跡をrelease recordへ集約し、release approverがHigh 2をclosedにしてから一般公開する。
