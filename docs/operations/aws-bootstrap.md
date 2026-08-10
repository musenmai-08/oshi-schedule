# AWS bootstrap

この手順はAWS resourceを作る直前のrunbookである。STEP 4の実装・検証では以下のcommandを実行しておらず、CloudFormation stackも存在しない。実行するとECR、ALB、RDS、public IPv4などの課金が始まるため、先に[費用見積](cost-estimate.md)を承認する。

GitHubのdefault branchが`main`、`staging`/`production` Environmentが作成済み、mainのCI validate/E2Eが成功済みであることもbootstrapの前提とする。workflowがdefault branchに存在しない状態やCI失敗中にはAWS resourceを作らない。

## 必要な入力

- AWS account ID、`ap-northeast-1`などのregion、初回bootstrapに使うAWS CLI profile
- registrable domain/TLD、Route 53 hosted zone ID/name
- staging Web/API FQDN、ACM certificate ARN、SNS通知email、月額budget USD
- RDS instance type、storage、backup retention、deletion protection、Multi-AZ方針
- GitHub owner/repository
- staging Supabase projectと公開URL/publishable key
- staging Google Cloud project、OAuth client ID/secret、YouTube API key
- allowed emailとCSPRNG生成したversion付きtoken encryption key

実値のSecretはissue、commit、CloudFormation context、CLI outputへ書かない。

## 1. identityと静的検証

```bash
source ~/.nvm/nvm.sh
nvm use 22.23.1
aws sts get-caller-identity --profile <profile>
pnpm --filter @oshi-schedule/infra typecheck
pnpm --filter @oshi-schedule/infra test
pnpm --filter @oshi-schedule/infra synth
```

最後の`synth`はdomainなしでも成功し、TLS未設定のALB listenerは503固定応答になる。これは検査用であり完成したHTTP stagingではない。full deployでは必ず`deployReady=true`を指定し、domain/certificate/public Web設定が欠ければconfig validationで停止させる。

CDK CLIの`-c key=value`は値を文字列としてapplicationへ渡す。boolean contextは共通parserがbooleanまたは小文字の文字列`true`/`false`だけを受け付け、未指定時は`cdk.json`または実装のdefaultを使う。`TRUE`、`yes`、`1`、空文字などはsynth/deploy前に設定エラーとして拒否する。

### RDS MySQL minor version

2026-08-05確認時点で、staging/productionはRDS for MySQL 8.4.10を固定指定する。AWSはMySQL 8.4を全Commercial Regionで提供し、8.4.10を現行対応minorとして掲載している。8.4.10のRDS standard support終了予定は2027-07-07、旧8.4.6は2026-09-30である。CDKは`MysqlEngineVersion.VER_8_4_10`を使い、Prisma migration/integration testはMySQL 8.4系で検証する。

AWSログイン後、実deploy直前に東京regionのlive catalogも確認する。

```bash
aws rds describe-db-engine-versions --profile <profile> --region ap-northeast-1 \
  --engine mysql --engine-version 8.4.10 \
  --query 'DBEngineVersions[0].EngineVersion' --output text
```

minor更新時はAWSのsupported versionと終了日、東京regionのlive catalog、利用中CDKの定数を確認し、stack/testのversionを同時に変更する。MySQL integration、CDK test/synth、`cdk diff`を通し、既存環境ではsnapshot/maintenance windowを承認してから適用する。majorは8.4のまま維持し、未検証の自動major upgradeは行わない。

## 2. CDK toolkitとECR-first bootstrap

CDK toolkit bootstrap自体がAWS resourceを作る。account/regionを再確認してから一度だけ実行する。

```bash
AWS_PROFILE=<profile> pnpm --filter @oshi-schedule/infra cdk bootstrap \
  aws://<account-id>/<region>

AWS_PROFILE=<profile> pnpm --filter @oshi-schedule/infra cdk deploy \
  -c environment=staging \
  -c bootstrapOnly=true \
  -c deployReady=true \
  -c awsAccount=<account-id> \
  -c awsRegion=<region>
```

この段階はVPC（public subnetとisolated database subnet、NATなし）とimmutable ECR repositoryだけを同じstackに作る。ECS service、RDS、ALB、Scheduler、Amplify、Budget、application Secret/Parameterは作らない。`deployReady=true`はaccountを必須化し、`bootstrapOnly=true`との組み合わせではfull deploy入力を要求しない。出力されたrepositoryへ検証済みimageをcommit SHA tagでpushし、digestを記録する。

```bash
docker build --platform linux/amd64 -t oshi-schedule:<commit-sha> .
aws ecr get-login-password --region <region> --profile <profile> | \
  docker login --username AWS --password-stdin <account-id>.dkr.ecr.<region>.amazonaws.com
docker tag oshi-schedule:<commit-sha> <repository-uri>:<commit-sha>
docker push <repository-uri>:<commit-sha>
```

## 3. Secret、Parameter、TLS

AWS Consoleまたは標準入力/保護された一時fileを使い、次のSecrets Manager名へ実値を投入する。値をshell引数へ直書きしない。

```text
oshi-schedule-staging/app/supabase-service-role-key
oshi-schedule-staging/app/google-client-secret
oshi-schedule-staging/app/youtube-api-key
oshi-schedule-staging/app/token-encryption-keys
```

次のSSM Parameterを事前作成する。

```text
/oshi-schedule-staging/runtime/allowed-emails
/oshi-schedule-staging/runtime/supabase-url
/oshi-schedule-staging/runtime/google-client-id
```

`ALLOWED_EMAILS`はカンマ区切りで、個人情報としてSecureStringを推奨する。customer managed KMS keyを使う場合はECS execution roleの`kms:Decrypt`をCDKへ追加する。CDKは`APP_MODE=real`、`TRUST_PROXY_HOPS=1`、Web origin、log/quota parameterを作る。RDS username/passwordはRDS managed secretが生成する。

Route 53 hosted zoneを確認し、staging API FQDNを含むACM certificateを同regionで発行・検証する。Web custom domainはAmplify domain associationで検証する。domain購入、certificate発行、DNS変更はユーザー操作である。

## 4. full stack

deploy前に`cdk diff`を読み、RDS/ALB/ECS/Budgetとremoval policyを確認する。例の値を実値に置換する。

`deployReady=true`かつ`bootstrapOnly=false`では、domain/certificate、通知先、GitHub、公開Supabase設定、既存immutable image tagを必須にする。入力不足または不正boolean contextのままfull stackをsynth/deployしない。

```bash
AWS_PROFILE=<profile> pnpm --filter @oshi-schedule/infra cdk diff \
  -c environment=staging -c deployReady=true -c bootstrapOnly=false \
  -c awsAccount=<account-id> -c awsRegion=<region> \
  -c hostedZoneId=<zone-id> -c hostedZoneName=<zone-name> \
  -c webDomainName=<staging-web-fqdn> -c apiDomainName=<staging-api-fqdn> \
  -c certificateArn=<acm-arn> -c alertEmail=<notification-email> \
  -c monthlyBudgetUsd=<usd> -c githubOwner=<owner> -c githubRepository=<repo> \
  -c nextPublicSupabaseUrl=<staging-supabase-url> \
  -c nextPublicSupabasePublishableKey=<publishable-key> \
  -c imageTag=<existing-immutable-tag>
```

同じcontextで`cdk deploy`するのはdiff、費用、Secret/Parameter、backup方針をユーザーが承認した後だけである。productionはさらに`-c environment=production -c confirmProduction=DEPLOY_PRODUCTION`を要求し、staging構築時には実行しない。

## 5. deploy後

1. SNS email subscriptionを承認する。
2. Amplify ConsoleでGitHub App接続と対象branchを選ぶ。OAuth tokenをCDK/GitHub Secretへコピーしない。
3. Supabase Site/Redirect URLとGoogle Cloud authorized originをstaging FQDNへ設定する。Google provider redirect URIはSupabase callbackのままにする。
4. one-off migration taskを成功させてからAPIを更新する。
5. `scripts/smoke-staging.sh`を実行し、最後にSchedulerを有効化する。
6. `STAGING_DEPLOY_ENABLED=true`は初回手動deployとsmoke成功後にだけGitHub Repository Variableへ設定する。

## destroy

staging廃止時はSchedulerをdisable、ECS desired countを0、必要snapshotを取得し、対象account/stackを再確認してから`cdk destroy`する。production stackでは日常的に実行しない。destroy後もRDS snapshot、RDS/アプリSecret、ECR image、ALB log bucketがretainされ、課金が続く可能性がある。残存resourceを一覧化し、data retention承認後に個別削除する。
