# GitHub Actions設定

## workflow

- `ci.yml`: PR/main/manual/reusable。Node.js 22.23.1、pnpm 9.15.9、MySQL 8.4、migration/schema drift、typecheck、lint、unit/integration test、build、OpenAPI/YAML、CDK test/synth、Docker build、Playwright E2Eを検証する。
- `deploy-staging.yml`: `STAGING_DEPLOY_ENABLED=true`のときだけmain/manualから動く。OIDC、build、Trivy HIGH/CRITICAL scan、ECR push、one-off migration、API/worker、Amplify、smokeの順である。
- `deploy-production.yml`: `workflow_dispatch`だけ。GitHub Environment approval、確認文字列、staging稼働digest、available RDS snapshotを必須にし、同じmanifestだけをproduction ECRへ昇格する。

外部actionはcurrent major/releaseを指定する。Dependabot等で更新する場合はrelease noteと権限変更をreviewし、特にsecurity scannerはrelease署名とadvisoryを確認する。

## GitHub Environment

`staging`と`production`を作る。productionはrequired reviewerを設定し、self-approvalを禁止する。workflow concurrencyも環境ごとに1つで、migrationの並行実行を防ぐ。長期AWS access keyは登録せず、CDK出力のenvironment別OIDC role ARNをRepository Variableとして使う。

## Repository Variables

共通:

```text
AWS_ACCOUNT_ID
AWS_REGION
```

stagingは次を設定する。値はCDK outputとAWS Consoleから照合し、Secret実値を入れない。

```text
STAGING_DEPLOY_ENABLED
STAGING_AWS_DEPLOY_ROLE_ARN
STAGING_ECR_REPOSITORY
STAGING_ECS_CLUSTER
STAGING_ECS_API_SERVICE
STAGING_ECS_API_TASK_FAMILY
STAGING_ECS_WORKER_TASK_FAMILY
STAGING_ECS_MIGRATION_TASK_FAMILY
STAGING_ECS_PUBLIC_SUBNET_IDS
STAGING_ECS_WORKER_SECURITY_GROUP_ID
STAGING_WORKER_SCHEDULE_NAME
STAGING_AMPLIFY_APP_ID
STAGING_AMPLIFY_BRANCH
STAGING_WEB_URL
STAGING_API_URL
```

productionは同じsuffixの`PRODUCTION_*`に加え、staging稼働digest照合用の`STAGING_ECR_REPOSITORY`、`STAGING_ECS_CLUSTER`、`STAGING_ECS_API_SERVICE`を使う。

## Secretの境界

GitHub Actionsはapp Secretを取得しない。task definition内のSecrets Manager/SSM ARN参照を新revisionへ複製するだけである。Amplifyへ渡すのは`NEXT_PUBLIC_API_URL`、Supabase URL/publishable key、`NEXT_PUBLIC_DEMO_MODE=false`だけで、service role key、OAuth secret、YouTube key、暗号鍵を渡さない。

OIDC trustは`repo:<owner>/<repository>:ref:refs/heads/main`とaudience `sts.amazonaws.com`へ限定する。productionもmainからworkflow dispatchする。repository名やdefault branchを変更したら、先にCDK trust policyをreviewする。

## 初回有効化

1. [AWS bootstrap](aws-bootstrap.md)でfull staging stackとOIDC roleを作る。
2. Environment/Variablesを設定し、production required reviewerを有効化する。
3. GitHubとAmplifyを管理画面で接続する。
4. CIを手動実行して成功を確認する。
5. staging deployをmanualで一度成功させる。
6. 最後に`STAGING_DEPLOY_ENABLED=true`を設定する。

失敗時はmigrationより後へ進まない。deployment summaryの直前task revisionを使ってcodeを戻し、DBはdown migrationではなくforward-fixまたは検証済みsnapshotから新instanceへ復元する。
