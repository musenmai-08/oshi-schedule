# インフラ候補と費用見積

## 見積の扱い

- 料金確認日: **2026-08-04**
- 通貨: USD、税・為替・domain年額を除く。日本円換算は契約時の為替を使う。
- region: AWS/GCPは東京を前提にするが、公式price pageの表示、契約、使用量で変わるため金額はquoteではなくplanning rangeである。
- 730時間/月、stagingとproductionを常設、少量traffic/log/build、workerは各環境で1時間ごとに平均2〜5分、APIは初期0.25 vCPU/0.5 GiB相当を仮定する。
- promotion credit、期間限定free tier、tax、support plan、大量egressは合計から除外する。構築前に[AWS Pricing Calculator](https://calculator.aws/)と[Google Cloud Pricing Calculator](https://cloud.google.com/products/calculator)でresource/regionを確定する。

## 公式仕様・料金の確認先

| 分類                | 公式参照先                                                                                                                                                                                                                                                    | この設計で使う事実                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Amplify             | [pricing](https://aws.amazon.com/amplify/pricing/)、[Next.js SSR support](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-amplify-support.html)、[Node.js support](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-supported-features.html) | pay-as-you-use、SSR compute/build/hosting、Next.js 12〜15 SSR/App Router/middleware、Node 22をsupport                       |
| Fargate             | [pricing](https://aws.amazon.com/fargate/pricing/)                                                                                                                                                                                                            | requested vCPU、memory、storageのtask実行秒数で課金                                                                         |
| ALB                 | [pricing](https://aws.amazon.com/elasticloadbalancing/pricing/)                                                                                                                                                                                               | load balancer hoursとLCUが固定費の一部                                                                                      |
| RDS MySQL           | [pricing](https://aws.amazon.com/rds/mysql/pricing/)、[MySQL version](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/MySQL.Concepts.VersionMgmt.html)                                                                                                 | instance/storage/backupで課金、MySQL 8.4系を利用可能                                                                        |
| Scheduler           | [EventBridge Scheduler](https://aws.amazon.com/eventbridge/scheduler/)、[ECS scheduled task](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/tasks-scheduled-eventbridge-scheduler.html)                                                          | 月14 million invocationのfree allowance、Fargate RunTaskをschedule可能                                                      |
| ECR/IPv4/Secret     | [ECR](https://aws.amazon.com/ecr/pricing/)、[public IPv4](https://aws.amazon.com/vpc/pricing/)、[Secrets Manager](https://aws.amazon.com/secrets-manager/pricing/)                                                                                            | ECR storage、public IPv4 $0.005/hour、Secret $0.40/month + API call                                                         |
| Vercel              | [plans](https://vercel.com/docs/plans/hobby)、[pricing](https://vercel.com/pricing)、[Next.js](https://vercel.com/docs/frameworks/full-stack/nextjs)                                                                                                          | Hobbyはnon-commercial personal use、Proは$20/user/monthとusage credit、Next.js機能への適合が高い                            |
| App Runner          | [pricing](https://aws.amazon.com/apprunner/pricing/)、[request timeout](https://docs.aws.amazon.com/apprunner/latest/dg/develop.html)                                                                                                                         | provisioned/active compute課金、request total timeoutは120秒                                                                |
| Cloud Run/Cloud SQL | [Cloud Run](https://cloud.google.com/run)、[Cloud SQL pricing](https://cloud.google.com/sql/pricing)、[Cloud Run jobs](https://cloud.google.com/run/docs/create-jobs)                                                                                         | request/task従量、Jobs利用可。Cloud SQL instanceは常設固定費、shared-coreはSLAなし                                          |
| Supabase            | [pricing](https://supabase.com/pricing)、[compute billing](https://supabase.com/docs/guides/platform/manage-your-usage/compute)、[backups](https://supabase.com/docs/guides/platform/backups)                                                                 | Freeは2 active projectsだがinactive pause、Pro $25に1 project分のcompute credit、追加Micro projectは概ね$10、Pro backup 7日 |
| YouTube             | [quota overview](https://developers.google.com/youtube/v3/getting-started)、[`search.list`](https://developers.google.com/youtube/v3/docs/search/list)                                                                                                        | defaultは一般quota 10,000 units/dayに加えsearch用100 queries/day。30 channel毎時はそのままでは不可                          |

料金ページはregionや使用量を対話的に計算するものがあり、東京の単価を本文へ固定しない。以下は安全側に丸めた範囲である。

## 3案比較

| 評価軸         | 案A: Vercel + AWS                                            | 案B: AWS統一（採用）                                                               | 案C: Cloud Run + Cloud SQL                                         |
| -------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Web            | Vercel                                                       | Amplify Hosting                                                                    | Cloud RunまたはFirebase Hosting連携                                |
| API            | ECS Fargate Service                                          | ECS Fargate Service                                                                | Cloud Run Service                                                  |
| worker         | Scheduler + Fargate Task                                     | Scheduler + Fargate Task                                                           | Cloud Scheduler + Cloud Run Job                                    |
| MySQL          | RDS for MySQL                                                | RDS for MySQL                                                                      | Cloud SQL for MySQL                                                |
| 月額beta概算   | $143〜200                                                    | **$123〜180**                                                                      | $95〜160                                                           |
| 無料枠         | Vercel Hobbyは非商用のみ。AWS各free allowanceは条件/期限あり | Amplify/Scheduler等にallowance。RDS/ALB常設分は残る                                | Cloud Run request/compute allowance。Cloud SQL固定費は残る         |
| 最低固定費     | RDS、ALB、API、商用Vercel Pro seat                           | RDS 2台、ALB、API tasks、public IPv4                                               | Cloud SQL 2台、network。Cloud Runはscale-to-zero可能               |
| 小traffic      | Web変動は小さいがVercel Pro固定費あり                        | Web変動が小さく、AWS control planeを統一                                           | computeは最安になり得るがDB固定費あり                              |
| Web deploy     | 最も容易、Next.js first-class                                | Next.js 15機能の対応範囲内。Edge API/streaming/on-demand ISRは非対応だが現行未使用 | Next.js SSR containerのbuild/運用が必要                            |
| API deploy     | AWSとVercelに分散                                            | image/ECSへ統一                                                                    | container deploy容易、cold startとrequest timeoutを設計            |
| worker定期実行 | native Fargate task                                          | native Fargate task                                                                | Cloud Run Jobが適合                                                |
| MySQL接続      | RDS private connectionをAWS内で完結                          | RDS private connectionをAWS内で完結                                                | Cloud SQL connector/private IPとpool調整                           |
| Secret         | VercelとAWSの2か所                                           | Secrets Manager/SSMへ集約（Webは公開値のみ）                                       | Secret Managerへ集約可能                                           |
| log/monitor    | Vercel + CloudWatchに分散                                    | CloudWatch中心                                                                     | Cloud Logging/Monitoring中心                                       |
| HTTPS/domain   | 双方自動化、2 control planes                                 | Amplify + ACM/ALB、Route 53                                                        | managed certificate/domain mapping                                 |
| CI/CD          | Vercel Git連携 + GitHub/AWS                                  | GitHub Actions OIDC + Amplify/ECS                                                  | GitHub OIDC/WIF + Cloud Run                                        |
| staging分離    | Vercel project + AWS resources                               | Amplify app + AWS resourcesをtag/SG/IAMで分離                                      | GCP services/project/resourcesを分離                               |
| scale          | Webは容易、APIはECS scale                                    | ECS desired count、RDS class/Multi-AZへ段階拡張                                    | Cloud Run auto scaleが容易。DB connection上限に注意                |
| cold start     | Webは低い、API常駐                                           | API desired 1で回避、workerのみtask起動待ち                                        | API scale-to-zero時に発生。min instanceで費用増                    |
| lock-in        | Vercel + AWSの2種                                            | AWS managed serviceに集中。container/MySQLは移植可能                               | GCP managed serviceに集中。container/MySQLは移植可能               |
| 運用負荷       | Webは楽だが権限/請求/logが分散                               | ECS/ALB構築は中程度、以後1 cloudで確認                                             | Cloud Runは軽いが現行AWS候補から知識/運用を切替                    |
| 個人開発       | commercial判定時のPro固定費に注意                            | **予測可能性と将来scaleの均衡が良い**                                              | 最安候補だがcold start/pool/rate-limitの検証が増える               |
| 固有の注意     | OAuth envをVercelとAWSで揃える                               | Amplify対応機能、API graceful shutdown、ALB proxy設定                              | 複数instance時のメモリrate-limit、Cloud SQL connection、cold start |

案Cは価格だけなら採用案より安くなる可能性があるが、実traffic/Cloud SQL class/egressのcalculator見積をまだ固定していないため断定しない。AWS案はRDS/ALB固定費を受け入れ、runtime、network、Secret、log、権限を1 cloudに集約する判断である。

App RunnerはExpressを簡単にdeployできる一方、total request timeout 120秒が現行の長めの手動同期に合わない。Lambda + API Gatewayは同期処理をjob化する大きな変更が必要なため候補から外す。

## 採用構成の費用内訳

2環境合計の通常月。幅はinstanceの東京単価、storage、log/build/traffic差を含む。

| 項目                                                  |                              月額概算 | 性質                                                |
| ----------------------------------------------------- | ------------------------------------: | --------------------------------------------------- |
| RDS MySQL Single-AZ x 2、20 GiB gp storage            |                               $35〜65 | 最大の固定費。実class単価をcalculatorで確認         |
| ECS API desired 1 x 2 + hourly worker tasks           |                               $10〜25 | 主にAPI常駐compute。worker変動は小さい              |
| shared ALB x 1                                        |                               $18〜30 | load balancer hour + LCU                            |
| public IPv4（ALB 2個、ECS API x 2常時、worker実行時） |                               $14〜18 | ALBもpublic IPv4課金対象。NAT Gatewayを置かない構成 |
| Amplify Web x 2                                       |                                 $0〜5 | build、SSR request/compute、hosting/egress          |
| Secrets Manager、ECR、CloudWatch/S3、Route 53         |                                $5〜15 | Secret数、log量、image retentionで変動              |
| AWS小計                                               |                          **$82〜162** | usageにより変動                                     |
| Supabase                                              | Free $0、beta Pro 2 projectsは概ね$35 | Authの可用性/backup要件で選択                       |

共有ALBはhost ruleで環境分離して固定費を抑える。security境界やaccount分離が必要になったらproduction専用ALBへ移す。NAT Gatewayは初期採用せず、固定outbound IP、private-only task、AWS private endpoint要件が生じた時点で再検討する。

## 規模別概算

### 規模1: 本人のみ

```text
初期費用：AWS resource作成は$0、未購入domainは年$10〜30程度を別計上
月額固定費：$77〜115
月額変動費：$5〜15
合計概算：$82〜130（Supabase Freeを仮定）
主な増加要因：staging/productionのRDS 2台、shared ALB、API常駐task、public IPv4
```

Supabase Freeのinactive pauseやbackup条件を受け入れられる本人利用だけを想定する。常時stagingが不要な月はAPI/RDS停止運用で下げられるが、worker定期実行と即時検証はできなくなるため基本見積には入れない。

### 規模2: 招待制beta（10 user、最大30 distinct channel）

```text
初期費用：AWS resource作成は$0、domain年$10〜30程度を別計上
月額固定費：$112〜160（Supabase Pro 2 projects約$35を含む）
月額変動費：$11〜20
合計概算：$123〜180
主な増加要因：Supabase Pro、RDS/ALB固定費、log、build、少量egress
```

30 channelを毎時`search.list`すると720 queries/dayで、defaultの100 search queries/dayを超える。これは課金で自動解消するものではない。時分割/頻度変更/既知動画追跡またはquota増枠がbeta開始の前提である。

### 規模3: 小規模一般公開（100 user、100〜300 channel）

```text
初期費用：resource作成は$0、domain年額を別計上。quota審査/運用作業費は含めない
月額固定費：$180〜310
月額変動費：$40〜80
合計概算：$220〜390
主な増加要因：production API 2 tasks、RDS class/Multi-AZ、shared rate-limit store、log/egress、Supabase compute
```

YouTube search quota拡張とfetch頻度最適化済みを仮定する。production RDSをMulti-AZ/t4g.small相当、API desired 2、shared Valkey storeを候補に含むため幅が大きい。実測前に固定費を先行投入しない。

## RDSが費用中心になる理由と代替

RDSはtrafficがほぼなくてもinstanceとstorageが常時課金され、staging/productionの独立要件で2台になる。Aurora Serverless v2は0 ACU auto-pause対応構成もあるが、hourly workerがwakeさせ、復帰遅延とAurora互換性検証が増えるため初期採用しない。Railway MySQL等は低価格になり得るが、private network、PITR、外部キー/transaction、Prisma migration、東京latencyを同等条件で公式見積できていないため未採用とする。

費用を最優先にする場合、構成変更より先に「stagingを常設する必要がある時間帯」を見直す。ただしmigration/OAuth/workerの継続検証環境という要件を失うため、招待制betaでは常設を維持する。

## 見直し条件

- 構築直前、四半期ごと、AWS/GCP/Supabase price変更時にcalculatorを更新する。
- 実請求が見積上限を2か月連続で20%超えたらresource tag別costを確認する。
- RDS+ALBがAWS請求の70%を超えたらAurora Serverless v2、Cloud SQL、低価格managed MySQLを同じRPO/RTO/TLS条件で再比較する。
- API desired count 2、100 active users、月100 GiB超egress、またはRDS CPU/connection 70%超でscale見積を更新する。
- 商用公開前にVercelを再比較する場合はHobbyを候補にせずPro料金を使う。
- `search.list` quotaは費用と別に毎release確認し、projectの実quota画面をsource of truthとする。

## 未確認・利用者判断

- 実際のregistrable domain/TLDと年額は未決定・未購入。
- AWS東京regionの最終SKU（RDS class、Fargate architecture、backup超過、CloudWatch量）はresource作成前のcalculator確認が必要。
- betaでSupabase Proを契約する時期と月額budget上限は利用者の承認が必要。
- 案Cの正確な東京見積は採用しないため未確定。AWS上限を超えた場合の再比較時にcalculatorで確定する。

## 関連文書

- [採用構成](../architecture/deployment-architecture.md)
- [環境戦略](environment-strategy.md)
- [監視とcost alarm](monitoring.md)
