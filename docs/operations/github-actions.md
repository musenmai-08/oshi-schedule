# GitHub Actions設定

## workflow

- `ci.yml`: PR/main/manual/reusable。Node.js 22.23.1、pnpm 9.15.9、MySQL 8.4、migration/schema drift、typecheck、lint、unit/integration test、build、OpenAPI/YAML、CDK test/synth、Docker build、Playwright E2Eを検証する。
- `deploy-staging.yml`: `STAGING_DEPLOY_ENABLED=true`のときだけmain/manualから動く。OIDC、build、Trivy HIGH/CRITICAL scan、ECR push、one-off migration、API/worker、Amplify、smokeの順である。
- `deploy-production.yml`: `workflow_dispatch`だけ。GitHub Environment approval、確認文字列、staging稼働digest、available RDS snapshotを必須にし、同じmanifestだけをproduction ECRへ昇格する。

外部actionはcurrent major/releaseを指定する。Dependabot等で更新する場合はrelease noteと権限変更をreviewし、特にsecurity scannerはrelease署名とadvisoryを確認する。

## repository前提

GitHubのdefault branchとデプロイ対象branchはどちらも`main`とする。workflow、CDKのOIDC subject、Amplify branchは`main`を前提にしており、過去の監査branchへ合わせて変更しない。`workflow_dispatch`のworkflowはdefault branchに存在して初めてGitHub UIから安定して選択できるため、default branchが別branchのままなら`Deploy production`が表示されないことがある。AWS bootstrap前にRepository settingsでdefault branchを`main`へ変更し、Actions画面で3 workflowを確認する。

CIのproduction Web buildは、実環境やGitHub Secretに依存しない次の予約済み公開テスト値をworkflow-level `env`から使う。`example.invalid`は実接続先ではない。PlaywrightはAPI URLを`http://127.0.0.1:4310`、demo modeを`true`へ上書きし、実Supabase、Google、YouTubeへ接続しない。

```text
NEXT_PUBLIC_API_URL=https://api.ci.example.invalid
NEXT_PUBLIC_DEMO_MODE=false
NEXT_PUBLIC_SUPABASE_URL=https://supabase.ci.example.invalid
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_ci_only_not_a_secret
```

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

`STAGING_AMPLIFY_BRANCH`は`main`に固定する。productionの`PRODUCTION_AMPLIFY_BRANCH`も`main`であり、workflowは別の値を拒否する。`staging`と`production`はGitHub Environment／AWS環境名であってsource branch名ではない。

productionは同じsuffixの`PRODUCTION_*`に加え、staging稼働digest照合用の`STAGING_ECR_REPOSITORY`、`STAGING_ECS_CLUSTER`、`STAGING_ECS_API_SERVICE`を使う。

## Secretの境界

GitHub Actionsはapp Secretを取得しない。task definition内のSecrets Manager/SSM ARN参照を新revisionへ複製するだけである。Amplifyへ渡すのは`NEXT_PUBLIC_API_URL`、Supabase URL/publishable key、`NEXT_PUBLIC_DEMO_MODE=false`だけで、service role key、OAuth secret、YouTube key、暗号鍵を渡さない。

OIDC trustは`repo:<owner>/<repository>:ref:refs/heads/main`とaudience `sts.amazonaws.com`へ限定する。productionもmainからworkflow dispatchする。repository名やdefault branchを変更したら、先にCDK trust policyをreviewする。

## 初回有効化

1. GitHubのdefault branchを`main`にし、`staging`と`production` Environmentを作成する。productionはrequired reviewerを有効化する。
2. mainのCI validate/E2Eが両方成功したことを確認する。失敗中はAWS bootstrapへ進まない。
3. [AWS bootstrap](aws-bootstrap.md)でfull staging stackとOIDC roleを作る。
4. CDK outputに基づくRepository Variablesを設定する。
5. GitHubとAmplifyを管理画面で接続し、source branchに`main`を選ぶ。
6. staging deployをmanualで一度成功させる。
7. 最後に`STAGING_DEPLOY_ENABLED=true`を設定する。

失敗時はmigrationより後へ進まない。deployment summaryの直前task revisionを使ってcodeを戻し、DBはdown migrationではなくforward-fixまたは検証済みsnapshotから新instanceへ復元する。
