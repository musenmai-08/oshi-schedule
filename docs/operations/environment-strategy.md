# 環境戦略

## 方針

local、test、staging、productionのデータとcredentialを混在させない。個人開発の初期はAWS accountを1つに保ちつつ、外部に影響するproject、DB、Secret、OAuth client、URLはstagingとproductionで分離する。

## 環境マトリクス

| 項目               | local                             | test/CI                          | staging                                                                       | production                                                    |
| ------------------ | --------------------------------- | -------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| URL                | `http://localhost:3001` / `:4000` | localhost/ephemeral              | `https://staging.oshi-schedule.com` / `https://api-staging.oshi-schedule.com` | `https://oshi-schedule.com` / `https://api.oshi-schedule.com` |
| `APP_MODE`         | realで実受入、fakeで開発          | fake中心                         | real                                                                          | real                                                          |
| MySQL              | Docker MySQL 8.4                  | disposable MySQL 8.4             | 独立RDS                                                                       | 独立RDS                                                       |
| Supabase           | staging projectを明示利用         | fake、または専用test             | staging project                                                               | production project                                            |
| Google Cloud       | staging project/client            | fake                             | staging project/client                                                        | production project/client                                     |
| YouTube/Calendar   | 必要時のみ実service               | fake                             | 実service                                                                     | 実service                                                     |
| Secret             | 追跡外`.env`                      | GitHubにapp secretを置かずtest値 | staging専用                                                                   | production専用                                                |
| GitHub Environment | なし                              | pull request                     | `staging`                                                                     | `production` + manual approval                                |

production Web/API domainは確定済みである。staging欄は現在の実domainであり、productionへ流用しない。

## 分離単位

- **AWS**: 初期は同一account/regionでもenvironment別CDK stack、VPC、ECS cluster、ECR、HTTP API/VPC Link/Cloud Map、SQS/Pipes、RDS、IAM role、log group、Scheduler、Secrets/Parametersを使う。GitHub OIDC providerだけaccount内で共有する。全resourceに`Application=oshi-schedule`と`Environment` tagを付ける。
- **Google Cloud**: stagingとproductionでproject、OAuth consent/test users、OAuth client、YouTube quotaを分ける。quota増枠申請もproduction projectに限定する。
- **Supabase**: projectを分け、Auth user、Google provider設定、URL allowlist、keyを共有しない。productionの可用性を求めるbetaではPro planを前提とする。
- **DB**: RDS instance、database credential、subnet/security boundaryを分ける。schemaは同じmigration列を適用するがdataは移送しない。
- **GitHub**: `staging`と`production` Environmentを分け、productionにrequired reviewerとdeployment concurrencyを設定する。AWS認証はOIDCを使い、長期access keyは保存しない。
- **Domain**: staging/productionのWeb/APIを別hostにする。CORSは環境ごとに単一の正確なWeb originだけを許可する。

## OAuth URL

| 設定先                         | staging                                                      | production                                                      |
| ------------------------------ | ------------------------------------------------------------ | --------------------------------------------------------------- |
| Supabase Site URL              | `https://staging.oshi-schedule.com`                          | `https://oshi-schedule.com`                                     |
| Supabase Redirect URL          | `https://staging.oshi-schedule.com/auth/callback`            | `https://oshi-schedule.com/auth/callback`                       |
| アプリcallback                 | 同上                                                         | 同上                                                            |
| Google OAuth authorized origin | `https://staging.oshi-schedule.com`                          | `https://oshi-schedule.com`                                     |
| Google provider redirect URI   | `https://<staging-project-ref>.supabase.co/auth/v1/callback` | `https://<production-project-ref>.supabase.co/auth/v1/callback` |

Supabase project refや実domainはSecretではないが環境設定として管理し、document例の値をそのまま使わない。

## 環境変数の分類と配置

### Web設定

Amplify appの環境別build settingに設定する。`WEB_ORIGIN`はserver-side callbackだけが参照し、`NEXT_PUBLIC_*`だけがbrowser bundleへ含まれる。いずれにもSecretを入れてはならない。

| 変数                                   | 用途                                   |
| -------------------------------------- | -------------------------------------- |
| `NEXT_PUBLIC_API_URL`                  | 環境別API HTTPS origin                 |
| `WEB_ORIGIN`                           | server-side callback用Web HTTPS origin |
| `NEXT_PUBLIC_SUPABASE_URL`             | 環境別Supabase project URL             |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | browser向けpublishable key             |
| `NEXT_PUBLIC_DEMO_MODE`                | staging/productionは`false`            |

### Secret

ECS task起動時にAWS Secrets Managerから注入し、Docker image、build artifact、Amplify、GitHub Actionsの通常ログへ入れない。

| 変数                        | 推奨配置                                                                  | 備考                                          |
| --------------------------- | ------------------------------------------------------------------------- | --------------------------------------------- |
| `DATABASE_URL`              | RDS managed secretを参照してtask起動時に構成、または環境別Secrets Manager | TLS検証と小さいconnection poolを含める        |
| `SUPABASE_SERVICE_ROLE_KEY` | 環境別app secret                                                          | ECSのみ。browser禁止                          |
| `GOOGLE_CLIENT_SECRET`      | 環境別app secret                                                          | API/workerのみ                                |
| `YOUTUBE_API_KEY`           | 環境別app secret                                                          | Google projectごとに分離                      |
| `TOKEN_ENCRYPTION_KEYS`     | 専用versioned secret                                                      | app secretと分け、offline recovery copyを持つ |

実装名は`oshi-schedule-{environment}/app/<secret-name>`、RDS managed secretは`oshi-schedule-{environment}/rds/credentials`である。`SUPABASE_SERVICE_ROLE_KEY`、`GOOGLE_CLIENT_SECRET`、`YOUTUBE_API_KEY`、`TOKEN_ENCRYPTION_KEYS`を別Secretとして事前作成し、task execution roleに該当ARNのreadだけを許可する。

### 非Secretだが環境依存

| 変数                                                    | 配置                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------- |
| `NODE_ENV`、`PORT`、`SUPABASE_JWT_AUDIENCE`             | ECS task definition                                           |
| `APP_MODE`、`WEB_ORIGIN`、`TRUST_PROXY_HOPS`、log/quota | CDKが作るSSM Parameter                                        |
| `SUPABASE_URL`、`GOOGLE_CLIENT_ID`                      | stagingは事前作成SSM、productionは検証済みCDK contextから作成 |
| `ALLOWED_EMAILS`                                        | 事前作成するSSM SecureString                                  |
| timeout、lease、OAuth retry、YouTube quota/tracking設定 | SSM Parameter Store Standard。変更review対象                  |

parameter名は`/oshi-schedule-{environment}/runtime/<kebab-name>`である。customer managed KMS keyでSecureStringを作る場合は、ECS execution roleへそのkeyの`kms:Decrypt`を追加してからdeployする。`.env.example`の`SUPABASE_PUBLISHABLE_KEY`（`NEXT_PUBLIC_`なし）はAPIから参照されないためproductionへ配布しない。

## Secret運用

1. Secretはimage、Git、build output、CLI引数、ログへ書かない。GitHub ActionsはAWS OIDCでdeployし、app secretを読まない。
2. ECSはtask definitionのsecret referenceで実行時に取得する。rotation時は新revisionをdeployする。
3. `TOKEN_ENCRYPTION_KEYS`は`key-id:32-byte-base64`をcomma区切りにし、先頭keyで暗号化、後続keyで旧ciphertextを復号する。新key追加→再暗号化→復号監査→旧key除去の順にrotateする。
4. Secret参照失敗、既知のsample値、`APP_MODE=fake`、`NEXT_PUBLIC_DEMO_MODE=true`はdeploymentを失敗させる。
5. Secretの全文をCloudWatch、GitHub、support ticket、documentへ出さない。access auditはCloudTrailで確認する。

## YouTube quota

2026-08-04時点でdefault projectには`search.list`用の100 search query units/dayという独立budgetがある。アプリのdefaultは80/day、scheduled reserveは72/dayである。30チャンネルを毎時検索すると720 calls/dayになりdefault quotaでは実行できない。beta開始前に次のいずれかを採る。

- 頻度を落とす、チャンネルを時分割する、既知broadcastを`videos.list`で追跡する。
- production Google Cloud projectでquota増枠を申請する。

費用とは別のhard constraintとして、quota alarmと残量dashboardを必須にする。

## 関連文書

- [デプロイアーキテクチャ](../architecture/deployment-architecture.md)
- [デプロイ手順](deployment.md)
- [暗号鍵を含む復旧](backup-and-recovery.md)
