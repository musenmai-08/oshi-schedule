# production serverless 最終preflight監査

> 2026-09-06 post-deploy追記: release SHA `3c23218ca95ddc1cc0523ad5a87e3f9a091465b6` のdeploy runは成功し、CloudFormationは`UPDATE_COMPLETE`。API/Worker・health/ready・Queue/DLQ・ESM・Alarm・DB migration/runtime接続は確認済み。AmplifyはApp-only detached。ローカルCDK再synthでLambda Code 2件の差分が検出され、post-deploy diff 0の条件は未達であるため、bundle再現性の確認が残る。

監査日: 2026-09-06

## 判定

低コストserverless構成のresource境界と月額目安は妥当である。production DB境界とinfra/migration OIDC bootstrapは完了したが、**production本体deployはまだ実行不可**である。protected migration workflowによるrelease attestation、外部公開gate、別承認のfull detached deployが残る。

CDK diffはCloudFormation change setを作らない`--method=template --no-change-set`で取得した。DB URL Secretはcomplete ARNを使い、正式なproduction contextで再取得した。production本体deployは実行していない。

## 実状態とdiff

- AWS accountは`741448960817`、regionは`ap-northeast-1`、Lambda Concurrent executions quotaは`10`、unreserved concurrencyも`10`である。
- `oshi-schedule-production` stackは`UPDATE_COMPLETE`で、現在の管理resourceはECR Repository、CDK metadata、production infra/migration GitHub OIDC Role 2件とinline Policy 2件である。
- `api.oshi-schedule.com`のACM certificateは`ISSUED`。Route 53 hosted zoneは再利用し、現時点のapexにはNS/SOA以外のapplication recordはない。
- application Secret 4件、`/oshi-schedule-production/runtime/allowed-emails` SecureString、`database-migration-url`、`database-runtime-url`は存在する。値は取得・記録しない。
- production Amplify App、Lambda、SQS、backup bucket、production GitHub deploy/backup roleは未作成である。
- image rollback資産`951cc81`はECRに存在し、digest `sha256:99206b651bbcebd146c16894fb4f9f24036ec238b71959f10278d30dcd775daa`のBasic Scanは`COMPLETE`、finding 0である。Lambda runtimeはこのimageを参照しない。
- HEAD `e23611f`のGitHub Actions run `33974058088`はvalidate/e2eともsuccessである。

正式なproduction contextの`detached`構造diffは、既存ECRとbootstrap済みIAMを維持して次の42 resourceをCREATEする。UPDATE、DELETE、REPLACEは0件である。2つのDB URL Secretはいずれも実complete ARNで参照する。

| Resource種別                                                            | CREATE |
| ----------------------------------------------------------------------- | -----: |
| Amplify App（Branch / Domainは0）                                       |      1 |
| API Gateway HTTP API（API、Domain、Mapping、Integration、Route、Stage） |      6 |
| Lambda Function / EventSourceMapping / Permission                       |      4 |
| IAM Role / Policy                                                       |     10 |
| SQS Queue / QueuePolicy                                                 |      6 |
| CloudWatch Alarm / LogGroup                                             |      7 |
| S3 Bucket / BucketPolicy                                                |      2 |
| SNS Topic / Subscription                                                |      2 |
| DynamoDB Table                                                          |      1 |
| EventBridge Scheduler                                                   |      1 |
| Route 53 RecordSet                                                      |      1 |
| AWS Budget                                                              |      1 |
| **合計**                                                                | **42** |

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
2. **解消（AWS反映待ち）— GitHub identity**: infra、migration、Amplify接続、backupを`production-infra`、`production-migration`、`production-amplify`、`production-backup`の4環境へ分離した。全trustはowner/repositoryのimmutable ID完全一致で、infra roleはCDK bootstrap role、migration roleはmigration Secret、connector roleは対象Amplify App、backup roleは対象bucket/Secretだけへ限定する。
3. **解消 — Amplify接続順**: production既定phaseを`detached`とし、fresh deployはAppだけを作る。read-only guard後、短命PATを標準出力や引数へ出さず`UpdateApp`を1回実行し、repository完全一致を確認してから`connected` phaseがmain Branch→Domainの順で作る。
4. **解消（AWS反映待ち）— backup OIDC**: production backup trustを`repo:musenmai-08@165903509/oshi-schedule@1308836728:environment:production-backup`へ固定した。
5. **解消 — migration/deploy境界**: migrationとinfraを別workflow・別environment approvalへ分割した。infra deployは指定runが同一repository、同一commit、migration workflow成功であり、そのartifactが現在のmigration checksumと一致しない限りfailする。
6. **解消 — backup restore契約**: dumpと同じprefixでGit commit、migration ID、`migration.sql` checksumを記録したmanifestを保存する。backup時に実DBがGit migration列の正しいprefixであることを必須とし、未適用の次migrationがmainにあってもbackupを継続できる。restore rehearsalではmanifest、記録Git、復元DB `app._prisma_migrations`の3者を機械照合する。
7. **外部公開gate**: production Supabase URL matrix、Google provider/限定scope、consent/verification、Terms/Privacy最終承認はAWSから確認できない。infra deployとは分離できるが、一般公開前には必須である。

## migrationとrollback順序

1. migration owner URL Secretを非表示入力で作成した。既存baseline table 12件とbaseline checksum一致を確認したため、baselineを再適用せずPrisma metadataだけを`app` schemaへ非破壊移動した。
2. `oshi_runtime`はCSPRNG passwordへ更新し、app業務tableのDML/sequence権限だけを付与した。DDL、role/database CREATE、migration metadata DMLは拒否されることを確認した。
3. Supavisor transaction mode（6543、TLS、`schema=app`、`pgbouncer=true`、`connection_limit=1`）のruntime URL Secretを作成し、runtime connectionを確認した。
4. Prisma migration statusとschema diffは正常である。次はprotected `production-migration` workflowを**deploy対象と完全一致するcommit**で一度実行し、正式release attestation artifactを作成する。baselineは再適用しない。Lambda bundleまたはworkspace test解決の修正などでrelease SHAが変わった場合、旧SHA（`9169f54`および`cdff67b`を含む）のattestationは再利用しない。
5. 実complete DB ARNによるpreflight/diffは確認済みである。SchedulerはDISABLEDのまま、migration run IDを入力にしたfull detached infra deployを別承認で実施する。
6. infra失敗時はCloudFormation rollbackを確認する。Retainされたnamed resourceがあれば勝手に削除せず、resource importまたは個別cleanupを別承認にする。DB baselineは自動rollbackせず、未公開状態で保持する。
7. API/backup/restore/Amplify/OAuth/Sync受入後だけSchedulerを有効化する。公開後のrollbackはPostgreSQLを維持したまま直前のLambda codeへ戻し、MySQLへの逆変換は行わない。

## cost再計算

前提はAPI 10万request未満、manual sync 1,000件未満、Worker 1〜3分、Amplify build数回、log 5 GB未満である。

| Service                                  |          月額目安 |
| ---------------------------------------- | ----------------: |
| Secrets Manager 6件                      |           約$2.40 |
| Route 53 hosted zone/DNS                 |      $0.50〜$0.70 |
| Amplify Hosting/SSR                      |      $0.50〜$3.00 |
| Lambda API/Worker                        |         $0〜$3.00 |
| HTTP API                                 |         $0〜$0.20 |
| SQS / Scheduler / SNS / DynamoDB         |         $0〜$0.20 |
| CloudWatch logs/alarm                    |      $0.40〜$2.00 |
| S3 backup / ECR rollback image           |         $0〜$0.30 |
| Supabase Free                            |                $0 |
| **通常見込み**                           |  **約$4〜$10/月** |
| **free allowance枯渇・実行時間上振れ時** | **約$10〜$12/月** |

`$4〜10`は低trafficかつAWS account全体のfree allowanceを大きく消費しない限り妥当である。Workerが毎回3分近く動く、Amplify転送/build、CloudWatch logが増える場合は上限を超える。IaCの月額Budgetは20 USD、forecast 80%（16 USD）通知であり、見込み額より余裕を持たせた事故検知値である。

## 次に必要なwrite

次のproduction writeはprotected `production-migration` workflowによるidempotentなmigration status/attestation作成である。続くfull `detached` stack deployはCREATE 42、UPDATE/DELETE/REPLACE 0の構成であり、migration run IDを入力にした別承認を必要とする。deploy後にApp-only phase、guard付きrepository接続、connected Branch/Domain、公開受入を順に行う。
