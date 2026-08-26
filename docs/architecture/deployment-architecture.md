# デプロイアーキテクチャ

## ステータス

- 決定日: 2026-08-04（RDS minorは2026-08-05更新）
- 対象: 個人利用から招待制 beta、将来の小規模一般公開
- 採用案: AWS 統一構成（Web のみ AWS Amplify Hosting、API/worker/DB は AWS のマネージドサービス）

AWS CDK、production image、CI/CDを実装し、2026-08-26までにstaging stack、Amplify custom domain、実OAuth、要求時同期、定期同期を受入確認した。現在のAWS実状態は[staging handoff](../operations/staging-handoff.md)を正とし、productionは同じ論理構成を環境専用値で新規構築する。

## 現行アプリケーションの実行要件

| 対象   | 現行要件                                                                                                    | デプロイ上の結論                                                               |
| ------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Web    | Next.js 15 App Router、SSR、`middleware.ts`、Route Handler の `/auth/callback`、`next build` / `next start` | 静的ホスティングのみでは不可。Next.js SSR と middleware を実行できる基盤が必要 |
| API    | Express、Node.js 22.23.1、port 4000、Bearer認証、Prisma/MySQL。同期要求はjob受付だけ                        | HTTP APIの30秒内で応答し、常駐processをそのまま動かせる                        |
| worker | scheduled/`SYNC_RUN_ID` targetedの一回実行CLI、正常系exit 0、失敗exit 1、lease/fencing                      | 定期実行と要求時one-off Fargate taskを同じ定義で共有                           |
| DB     | Prisma 6、MySQL、外部キー、transaction、lease/fencing、migration                                            | MySQL 8.4 系の独立した managed DB が必要。SQLite へは変更しない                |

Web の公開設定は `NEXT_PUBLIC_API_URL`、`NEXT_PUBLIC_DEMO_MODE=false`、`NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`。API/worker の秘密設定は [環境戦略](../operations/environment-strategy.md) に分類する。

APIは`GET /health`をprocess liveness、`GET /ready`をDB readinessとして分離した。`TRUST_PROXY_HOPS=1`、graceful shutdown、API/workerのPrisma切断も実装済みである。ECS container health checkはimage内のNode.jsでlocalhostの`/health`を確認し、deploy後のsmokeと運用監視は`/ready`も使う。

## 推奨構成

```mermaid
flowchart TB
  B[Browser] -->|HTTPS| AW[AWS Amplify Hosting<br/>Next.js Web]
  AW -->|PKCE / OAuth| SA[Supabase Auth]
  AW -->|HTTPS + Bearer token| HG[API Gateway HTTP API<br/>custom domain]
  HG -->|VPC Link + Cloud Map| API[ECS Fargate Service<br/>Express API]
  API -->|syncRunId only| Q[SQS encrypted queue]
  Q --> P[EventBridge Pipes]
  P -->|RunTask + SYNC_RUN_ID| WT
  SCH[EventBridge Scheduler<br/>rate(1 hour)] --> WT[ECS Fargate Task<br/>worker]
  API --> RDS[(RDS for MySQL)]
  WT --> RDS
  API --> EXT[Supabase / Google / YouTube APIs]
  WT --> EXT
  SM[Secrets Manager / SSM] -. runtime injection .-> API
  SM -. runtime injection .-> WT
  API --> CW[CloudWatch Logs / Metrics]
  WT --> CW
  HG --> CW
  Q --> CW
  RDS --> CW
  GH[GitHub Actions + OIDC] --> ECR[ECR<br/>immutable SHA image]
  ECR --> API
  ECR --> WT
  GH --> AW
```

productionとstagingは同じ論理構成を別stackとして使う。VPC、ECS cluster、ECR repository、HTTP API/VPC Link/Cloud Map、queue、ECS service、IAM role、security group、log group、Secrets、RDSを環境ごとに分離する。GitHub OIDC providerだけはaccount内で共有する。現行構成にALB/Target Group/Listenerは存在しない。

### コンポーネント責務

| コンポーネント | staging                                           | production                                     | 責務                                                 |
| -------------- | ------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------- |
| Web            | Amplify app（source: main、environment: staging） | 独立 Amplify app（source: main）               | Next.js SSR、middleware、CSP、Supabase PKCE callback |
| API edge       | HTTP API + VPC Link + Cloud Map                   | 環境別同構成                                   | `$default` HTTP_PROXY、custom domain、access log     |
| API            | Fargate service、desired count 1                  | Fargate service、betaはdesired count 1         | 認証、job受付、Google credential管理                 |
| worker         | Scheduler/Pipes → shared Fargate Task Definition  | 環境別同構成                                   | 定期同期とtargeted同期。一回実行後に終了             |
| sync queue     | encrypted Standard SQS + DLQ + EventBridge Pipes  | 環境別同構成                                   | durable dispatch、redrive、one-off RunTask           |
| MySQL          | RDS for MySQL 8.4.10、Single-AZ、独立 instance    | RDS for MySQL 8.4.10、Single-AZ、独立 instance | 永続データ、lease、fencing、migration                |
| image          | staging ECRのimmutable digest                     | 同じmanifestをproduction ECRへ昇格             | API と worker を同一 image、別 command で実行        |

Web はコンテナ化しない。API と worker は同じ source、Prisma Client、migration を含む同一 imageを使い、APIは`node api/dist/server.js`、workerは`node worker/dist/index.js`をcommandにする。migrationは同じimageの一回限りECS taskから`api/node_modules/.bin/prisma migrate deploy --schema=/opt/oshi-schedule/prisma/schema.prisma`を実行する。RDS managed secretのusername/passwordはentrypointがprocess memory上でTLS必須の`DATABASE_URL`へ構成し、imageやCloudFormationへ完全URLを保存しない。

## ネットワークと通信

- region は利用者と開発者に近い `ap-northeast-1`（東京）を暫定採用する。
- RDSはisolated subnetに置きpublic accessを無効にする。HTTP APIはVPC LinkからCloud Map SRV discoveryでAPI taskのprivate IP:4000へ接続する。Service Connectは単一serviceに不要なため使わない。
- ECS taskはpublic subnetとpublic IPv4をoutbound専用に使い、NAT Gateway固定費を避ける。API :4000 ingressはVPC Link security groupだけ、workerはinbound ruleなし、`0.0.0.0/0 -> :4000`は禁止する。
- DB security group は環境ごとの ECS security group から MySQL port のみ許可する。staging task から production DB、production task から staging DB へは接続できない。
- RDS 接続は AWS CA bundle を検証する TLS を必須とし、`DATABASE_URL` の connection pool は task 数に応じた小さい `connection_limit` にする。
- HTTP API private integration timeoutは上限30秒で、`POST /channels`と手動syncはDB transactionとSQS dispatchだけを待つ。外部同期をresponse条件にしない。

## TLS、HSTS、ドメイン

stagingの確定domainとproductionの設計用placeholderは次のとおり。productionの`example.com`は取得したregistrable domainへ置換する。

| 環境       | Web                                 | API                                     | アプリ callback                                   |
| ---------- | ----------------------------------- | --------------------------------------- | ------------------------------------------------- |
| staging    | `https://staging.oshi-schedule.com` | `https://api-staging.oshi-schedule.com` | `https://staging.oshi-schedule.com/auth/callback` |
| production | `https://app.example.com`           | `https://api.example.com`               | `https://app.example.com/auth/callback`           |

WebはAmplify/CloudFront、APIはAPI Gateway Regional Custom DomainとACM certificateでTLSを終端する。Route 53 AliasはRegional domainを指す。productionのHSTSはWebで付け、stagingとlocalhostには付けない。`includeSubDomains`と`preload`は全hostがHTTPSのみで安定した後に別判断する。

Supabase Site URL/Redirect URL、Google OAuth client、`WEB_ORIGIN` は環境ごとの完全一致 URL を使う。Google provider の redirect URI は各 Supabase project の `https://<project-ref>.supabase.co/auth/v1/callback` であり、アプリ callback とは別である。Web/API 間は cookie を共有せず Supabase access token を Bearer で渡すため、同一親ドメインへの依存はない。

## rate limit

- 招待制 beta は API desired count 1で開始し、既存のメモリ内 IP rate limit とDB上のユーザー/購読単位 cooldownを併用する。
- API Gateway/VPC Linkの1 hopだけを信頼するため`TRUST_PROXY_HOPS=1`をSSMから注入する。booleanの無条件`true`は使わず、左端X-Forwarded-Forを変えてrate limitを回避できないことをtestする。
- 認証後の制限はIPだけに頼らず、user ID単位を優先する。共有NATやIPv6の利用者を不当に巻き込まないためである。
- desired countを2以上にする前、またはメモリ内制限の不一致を観測した時点で、ElastiCache for Valkey/Redisの共有storeへ移す。小規模では固定費と運用対象を増やすため導入しない。

## scaling と強化条件

| 条件                                                         | 変更                                                                 |
| ------------------------------------------------------------ | -------------------------------------------------------------------- |
| API CPU または memory が15分以上70%超、p95 latencyが目標超過 | task sizeを上げる。次に desired count 2へ水平scale                   |
| desired countを2以上にする                                   | shared rate-limit storeを先に導入し、DB connection上限を再計算       |
| 招待制betaを越えて可用性要求が上がる                         | production APIを2 AZ/2 tasks、RDSをMulti-AZに変更                    |
| DB CPU/connection/storageが継続して70%超                     | RDS class/storageを拡張し、slow queryとindexを確認                   |
| チーム化、監査/請求/権限分離が必要                           | productionを別AWS accountへ移す                                      |
| workerが45分を超える、チャンネル数が100を超える              | channel単位job queue/分割taskを設計し、実行頻度とYouTube quotaを調整 |

## 採用・不採用判断

- **Amplify Hostingを採用**: Next.js 15 SSR、App Router、middleware、Node.js 22をサポートし、個人開発でWeb専用コンテナを運用せずに済む。現行アプリはAmplify非対応のEdge API routes、streaming、on-demand ISRを使っていない。
- **HTTP API + VPC Link + Cloud Mapを採用**: ALB時間固定費を除き、Express routeを`$default` HTTP_PROXYで維持する。stage prefixはrequest path overwriteで除く。API Gateway access logにAuthorization/bodyを含めない。
- **SQS + Pipes + Fargate Taskを要求時同期に採用**: DLQ/retry/durable queueを持ち、既存一回実行CLIとTask Definitionを共有する。direct RunTaskはAPI側IAM/再試行/損失管理が増え、DB job + scheduled fallbackだけでは即時性が落ちるため不採用。
- **Scheduler + Fargate Taskを定期同期に維持**: 一回実行型CLIとexit codeをそのまま使い、常駐workerを追加しない。
- **RDS for MySQLを採用**: Prisma migration、外部キー、transaction、lease/fencingをMySQLのまま使える。Aurora Serverless v2は小規模で構成と費用の利点が明確でなく、auto-pause復帰もある。MySQL互換PaaSは互換性・backup・network境界の検証対象が増えるため初期採用しない。
- **MySQL 8.4 minorを固定**: 初回構築はAWS/CDKが対応する8.4.10をstaging/production共通で使う。standard support終了日前にAWSの現行minor、東京region、Prisma、CDK定数を再確認し、integration testと`cdk diff`を経て更新する。
- VercelはNext.jsとの適合性が最も高いが、商用Proのseat固定費とAWSとの運用分散を避けるため採用しない。Cloud Run案はscale-to-zeroで安価になり得るが、Cloud SQLとの接続pool、cold start、複数cloudの監視と権限管理を優先課題にしないため採用しない。

詳細は[費用見積](../operations/cost-estimate.md)と[Web配置ADR](../decisions/0001-host-web-on-amplify.md)を参照する。

## STEP 4実装

- `Dockerfile`はNode.js 22.23.1/pnpm 9.15.9のmulti-stage build、非root、RDS CA bundle、API/worker/migration共用である。
- `infra/`はTypeScript AWS CDKで、NATなしのpublic compute/isolated RDS、HTTP API/VPC Link/Cloud Map、SQS/Pipes、environment別removal policyを定義する。
- Schedulerは安全側の既定disabled、`rate(1 hour)`、retry 2回、最大event age 1時間、SQS DLQを持つ。ECS STOPPEDかつexit code非0をEventBridge ruleでSNSへ通知する。
- Amplify App/branchはCDK管理するが、GitHub接続とdomain verificationは管理画面で人が完了する。
- 実構築手順は[staging構築](../operations/staging-setup.md)を正とする。

## 関連文書

- [環境分離とSecret](../operations/environment-strategy.md)
- [CI/CDとdeployment](../operations/deployment.md)
- [監視](../operations/monitoring.md)
- [バックアップと復旧](../operations/backup-and-recovery.md)
- [費用見積](../operations/cost-estimate.md)
