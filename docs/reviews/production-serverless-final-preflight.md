# production serverless 最終preflight監査

監査日: 2026-09-06

## 判定

低コストserverless構成のresource境界と月額目安は妥当だが、**production deployはまだ実行不可**である。実AWSにはserverless runtime用DB Secret 2件とGitHub production deploy roleがなく、Amplifyの初回repository接続とproduction backup OIDCにも未解消の契約差がある。

AWS、Supabase、Googleへのwriteは行っていない。CDK diffはCloudFormation change setを作らない`--method=template --no-change-set`で取得した。DB Secret 2件が未作成のため、構造diffだけは正式名に合う非実在ARNを使用した。このdiffをdeploy入力として再利用してはならず、Secret作成後にcomplete ARNで再実行する。

## 実状態とdiff

- AWS accountは`741448960817`、regionは`ap-northeast-1`、Lambda Concurrent executions quotaは`10`、unreserved concurrencyも`10`である。
- `oshi-schedule-production` stackは`CREATE_COMPLETE`で、現在の管理resourceはECR RepositoryとCDK metadataだけである。
- `api.oshi-schedule.com`のACM certificateは`ISSUED`。Route 53 hosted zoneは再利用し、現時点のapexにはNS/SOA以外のapplication recordはない。
- application Secret 4件と`/oshi-schedule-production/runtime/allowed-emails` SecureStringは存在する。`database-runtime-url`と`database-migration-url`は存在しない。
- production Amplify App、Lambda、SQS、backup bucket、production GitHub deploy/backup roleは未作成である。
- image rollback資産`951cc81`はECRに存在し、digest `sha256:99206b651bbcebd146c16894fb4f9f24036ec238b71959f10278d30dcd775daa`のBasic Scanは`COMPLETE`、finding 0である。Lambda runtimeはこのimageを参照しない。
- HEAD `e23611f`のGitHub Actions run `33974058088`はvalidate/e2eともsuccessである。

構造diffは既存ECRを同じlogical IDで維持し、次の42 resourceをCREATEする。UPDATE、DELETE、REPLACEは0件である。

| Resource種別 | CREATE |
| --- | ---: |
| Amplify App / Branch / Domain | 3 |
| API Gateway HTTP API（API、Domain、Mapping、Integration、Route、Stage） | 6 |
| Lambda Function / EventSourceMapping / Permission | 4 |
| IAM Role / Policy | 8 |
| SQS Queue / QueuePolicy | 6 |
| CloudWatch Alarm / LogGroup | 7 |
| S3 Bucket / BucketPolicy | 2 |
| SNS Topic / Subscription | 2 |
| DynamoDB Table | 1 |
| EventBridge Scheduler | 1 |
| Route 53 RecordSet | 1 |
| AWS Budget | 1 |
| **合計** | **42** |

templateにはRDS、ECS、VPC、subnet、NAT、VPC Link、Cloud Map、EventBridge Pipe、EIP/Public IPv4がない。runtime environment、Secret ARN、origin、domainにstaging/legacy/localhost参照もない。

## Security、concurrency、backup

- HTTP APIのexecute-api endpointはcustom domain構成時に無効化され、TLS 1.2、50 rps / burst 100である。Lambdaへのinvokeは該当API ARNに限定される。
- API/WorkerはSecret値をenvironmentへ展開せず、必要なcomplete ARNへの`GetSecretValue`だけを持つ。WorkerはSupabase service-role Secretとallowed-emailsへ到達しない。
- Worker event sourceはBatchSize 1、MaximumConcurrency 2、partial batch failure、90分visibility、3回後DLQである。reserved concurrencyはない。quota 10の範囲で成立するが、account内の他Lambdaとunreserved poolを共有するため、API/Worker throttle alarmを初回受入で必ず確認する。
- Schedulerは初回diffでは`DISABLED`、`rate(1 hour)`、SQS target、retry 2、maximum event age 1時間、専用DLQである。
- backup bucketはSSE-S3、Block Public Access、TLS強制、7日expiration、productionではRetain。backup roleは`database/*`へのPut/Getとmigration SecretのGetだけで、Delete権限を持たない。
- production log groupは30日。API access logはsource IPを含むため、Privacy記載と30日purgeを維持する。

## deploy前blocker

1. **DB境界未作成**: migration owner接続、`oshi_runtime` LOGIN role、DML-only grant、Supavisor transaction URL、migration session/direct URL、対応するSecret 2件が未作成。production `app` schemaが空であることも未確認で、baselineは未適用である。
2. **GitHub deploy identity不在**: `deploy-production.yml`は`PRODUCTION_AWS_DEPLOY_ROLE_ARN`を要求するが、実AWSにもserverless templateにもproduction deploy roleがない。OIDC providerだけではworkflowはassumeできない。
3. **Amplify初回接続順が不正**: templateのAmplify AppにはRepositoryがなく、`connected` phaseでBranch/Domainを同時作成する。fresh Appではmanual `main`となり、stagingで確認済みのAWS制約によりBranch存在中は後からrepository接続できない。App-only作成、repository接続、Branch/Domain作成の段階移行が必要である。
4. **backup OIDC subject不整合**: repositoryはimmutable owner/repository ID形式のOIDC subjectを使うが、production templateは旧`repo:owner/repository:environment:production-backup`形式である。現状ではproduction backup workflowのSTS認証が失敗する。
5. **migration/deployの原子性不足**: workflowはbaseline migration直後にfull stack deployする。後段deploy失敗時にDBだけ適用済みになるため、migrationとinfra deployを別承認・別記録に分離し、再実行時はmigration statusを確認して冪等に継続する必要がある。
6. **backup restore契約の未確定**: staging rehearsalではapp schema 12 tableを復元できたが、Prisma migration metadataはdump内で確認できなかった。production初回backup前に、migration metadataをdumpへ含めるか、release recordとGit migration IDから復元判定する正式手順を固定する。
7. **外部公開gate**: production Supabase URL matrix、Google provider/限定scope、consent/verification、Terms/Privacy最終承認はAWSから確認できない。infra deployとは分離できるが、一般公開前には必須である。

## migrationとrollback順序

1. production Supabase migration owner接続を非表示入力し、migration URL Secretを作る。`app` schemaが空でSupabase管理schemaへ変更がないことをread-only確認する。
2. CSPRNG passwordで`oshi_runtime`を作り、`prisma/runtime-role.sql`のDML/sequence権限だけを付与する。DDL、role管理、Supabase管理schema権限がないことを負のtestで確認する。
3. Supavisor transaction mode（6543、TLS、`pgbouncer=true`、`connection_limit=1`）のruntime URL Secretを作る。
4. baselineをmigration ownerで1回だけ適用し、migration status、schema diff、table/index/FK、runtime DDL拒否を確認する。失敗時は自動DROPしない。productionは未公開・空DBなのでwrite経路を開かず、原因修正後にmigrationの冪等状態から再開する。
5. blocker 2〜4をコード/IaCで解消後、実complete ARNによるpreflight/diffを再取得する。SchedulerはDISABLEDのままinfraをdeployする。
6. infra失敗時はCloudFormation rollbackを確認する。Retainされたnamed resourceがあれば勝手に削除せず、resource importまたは個別cleanupを別承認にする。DB baselineは自動rollbackせず、未公開状態で保持する。
7. API/backup/restore/Amplify/OAuth/Sync受入後だけSchedulerを有効化する。公開後のrollbackはPostgreSQLを維持したまま直前のLambda codeへ戻し、MySQLへの逆変換は行わない。

## cost再計算

前提はAPI 10万request未満、manual sync 1,000件未満、Worker 1〜3分、Amplify build数回、log 5 GB未満である。

| Service | 月額目安 |
| --- | ---: |
| Secrets Manager 6件 | 約$2.40 |
| Route 53 hosted zone/DNS | $0.50〜$0.70 |
| Amplify Hosting/SSR | $0.50〜$3.00 |
| Lambda API/Worker | $0〜$3.00 |
| HTTP API | $0〜$0.20 |
| SQS / Scheduler / SNS / DynamoDB | $0〜$0.20 |
| CloudWatch logs/alarm | $0.40〜$2.00 |
| S3 backup / ECR rollback image | $0〜$0.30 |
| Supabase Free | $0 |
| **通常見込み** | **約$4〜$10/月** |
| **free allowance枯渇・実行時間上振れ時** | **約$10〜$12/月** |

`$4〜10`は低trafficかつAWS account全体のfree allowanceを大きく消費しない限り妥当である。Workerが毎回3分近く動く、Amplify転送/build、CloudWatch logが増える場合は上限を超える。IaCの月額Budgetは20 USD、forecast 80%（16 USD）通知であり、見込み額より余裕を持たせた事故検知値である。

## 次に必要なwrite

最初のwriteはproduction Supabase/AWS DB境界の作成である。migration owner URL Secret作成、`oshi_runtime`作成・grant、runtime URL Secret作成を一つの明示承認工程にする。その前にblocker 2〜4とmigration workflow分離をコード/IaCで修正し、CI greenを得る。full production stack deployは、実Secret ARNでdiffを再確認した後の別承認とする。
