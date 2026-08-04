# 推しスケジュール

登録した YouTube チャンネルのライブ配信・プレミア公開予定を、利用者専用の Google カレンダーへ同期する招待制 Web アプリケーションです。Next.js、Express、Prisma/MySQL、Supabase Auth を pnpm/Turborepo で管理しています。

外部資格情報がなくても `APP_MODE=fake` で、ログイン済み状態からチャンネル登録、停止・再開、手動同期、解除、アカウント削除まで確認できます。

## 必要な環境

- Node.js 22.23.1 LTS（`.nvmrc` で固定）
- Corepack / pnpm 9.15.9
- Docker Desktop（実 MySQL を使う場合）

```bash
nvm use
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
```

`pnpm install` の postinstall、`pnpm typecheck` の pretypecheck、`pnpm build` の prebuild は Prisma Client を生成します。Prisma生成だけを明示実行する場合は `pnpm db:generate` を使います。

## 資格情報なしで起動（Fakeモード）

ターミナルを2つ使用します。

```bash
# terminal 1
APP_MODE=fake ALLOWED_EMAILS=developer@example.com pnpm --filter @oshi-schedule/api dev

# terminal 2
NEXT_PUBLIC_DEMO_MODE=true NEXT_PUBLIC_API_URL=http://localhost:4000 pnpm --filter @oshi-schedule/web dev
```

ブラウザーで `http://localhost:3001` を開き、「Googleでログイン」（デモでは外部通信なし）を押します。Fakeモードの状態はAPIプロセスのメモリ上にあり、再起動で初期化されます。

定期 worker の入口もFakeで確認できます。

```bash
APP_MODE=fake ALLOWED_EMAILS=developer@example.com pnpm sync:scheduled
```

## MySQL / 実サービスモード

```bash
docker compose up -d mysql
pnpm db:generate
pnpm exec prisma migrate deploy
pnpm db:seed
```

`.env.example` をコピーし、次を実値に置き換えます。

- `DATABASE_URL`
- `ALLOWED_EMAILS`（カンマ区切り）
- Supabase URL、publishable key、service role key
- Google OAuth client ID / secret
- YouTube Data API key
- `TOKEN_ENCRYPTION_KEYS`（CSPRNGで生成した32 byte乱数のbase64。例: `openssl rand -base64 32`。Secret Managerへ保存）

APIとworkerは、各workspace packageをcwdとして起動した場合もproject rootの `.env` を読みます。real/productionでは `.env.example` の全ゼロ鍵、既知sample、反復、連番など予測可能な鍵を拒否します。独自の強度推定を安全性の根拠にはせず、必ずOSのCSPRNGで生成し、ログやGitへ出さないでください。ローテーション時は `v2:<new>,v1:<old>` のように新鍵を先頭へ追加し、旧暗号文を復号して新鍵で再暗号化した後に旧鍵を外します。暗号文自身にもkey IDが保存されます。

外部HTTP timeoutとlease、YouTube quotaは `.env` で調整できます。`ACCOUNT_DELETION_LEASE_MS` と `SYNC_LEASE_MS` は `EXTERNAL_API_TIMEOUT_MS` より長くしてください。YouTubeは一般endpoint用 `YOUTUBE_DAILY_QUOTA_BUDGET=8000` と、独立したsearch bucket用 `YOUTUBE_DAILY_SEARCH_QUOTA_BUDGET=80` をDBで管理します。日付境界は `YOUTUBE_QUOTA_TIMEZONE=America/Los_Angeles`、予定検索は既定1ページ、追跡は1チャンネル50件・30日です。手動同期の再実行間隔（5分）と同期対象期間（30日）はプロダクト仕様の定数で、環境変数では変更しません。既定値では通常最大がSEARCH 72/日・GENERAL 144/日、3 attemptを含むGENERAL上限が432/日です。設定から再計算した上限をreserveが満たさなければ起動時に失敗します。自動同期用予約枠を手動同期が消費することはできません。API呼出し直前に予約し、応答成否にかかわらず実績へ移します。process crash時の未使用予約は二重消費防止を優先して当日中は解放せず、Pacific Timeの日次行で自然に分離します。

Supabase の Google provider に Calendar API scope を許可し、Auth URL Configuration の Site URLを `http://localhost:3001`、Redirect URLを `http://localhost:3001/auth/callback` に設定してください。Google Cloud の承認済みJavaScript生成元は `http://localhost:3001` にします。Google provider用の承認済みリダイレクトURIはSupabaseが提示する `https://<Supabase Project Ref>.supabase.co/auth/v1/callback` のままで、Webポート変更では変更しません。YouTube Data API v3、Google Calendar API、OAuth同意画面も設定します。

```bash
# terminal 1
APP_MODE=real pnpm --filter @oshi-schedule/api dev

# terminal 2
NEXT_PUBLIC_DEMO_MODE=false pnpm --filter @oshi-schedule/web dev

# scheduler / terminal 3
APP_MODE=real pnpm sync:scheduled
```

1時間ごとの実行はインフラのschedulerから `pnpm sync:scheduled` を呼びます。同期間隔はアプリ環境変数ではなく、デプロイ先schedulerの設定を正とします。worker はHTTPサーバーを必要としません。同じYouTubeチャンネルの取得はDB leaseとversion付きsnapshotで共有し、取得完了後は各subscriptionが自分のCalendarへ必ず展開します。完了snapshotがない後続workerやquota不足は`SUCCESS`にせず`DEFERRED`とし、保存済みデータのCalendar同期だけを続けます。

workerはSUCCESS/SKIPPED/DEFERREDと対象0件を終了コード0、1件以上のFAILEDまたはworker全体の例外を終了コード1にします。schedulerは非0終了を監視・通知し、終了ログの件数サマリーを収集してください。

## 品質確認

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm exec playwright install chromium  # 初回のみ
pnpm test:e2e
```

E2Eは既定でWeb `3310`、API `4310`を専用利用し、既存serverを再利用しません。並列CIでは`E2E_WEB_PORT`と`E2E_API_PORT`をjobごとに割り当てられます。APIの`/health`は`service: oshi-schedule-api`を返し、シナリオ開始時に対象アプリを識別します。

MySQLを含むAPI結合テストは、migration適用済みの分離DBを `TEST_DATABASE_URL` で指定して実行します。

```bash
TEST_DATABASE_URL=mysql://oshi:oshi_password@127.0.0.1:3306/oshi_schedule \
  pnpm --filter @oshi-schedule/api test -- src/prisma-api.integration.test.ts
```

APIの確認例:

```bash
curl http://localhost:4000/health
curl http://localhost:4000/ready
curl -H 'Authorization: Bearer demo-token' http://localhost:4000/api/v1/channels
```

`/health`はprocess livenessだけを返し、DB障害時もprocessが生きていれば応答します。`/ready`は軽量DB queryを行い、処理可能なら200、DB障害時は503を返します。外部Google/YouTube APIは呼びません。

## production container

API、worker、migrationはNode.js 22.23.1の同じmulti-stage imageを使います。runtimeは非rootで、`.env`を含めず、RDS CA bundleでTLSを検証します。

```bash
docker build -t oshi-schedule:local .

# 外部APIを呼ばないAPI確認
docker run --rm -p 4400:4000 \
  -e NODE_ENV=development -e APP_MODE=fake \
  -e ALLOWED_EMAILS=developer@example.com \
  oshi-schedule:local

# worker command
docker run --rm \
  -e NODE_ENV=development -e APP_MODE=fake \
  -e ALLOWED_EMAILS=developer@example.com \
  oshi-schedule:local node worker/dist/index.js

# ECS migration taskが使用するcommand（DATABASE_URLはruntime injection）
api/node_modules/.bin/prisma migrate deploy \
  --schema=/opt/oshi-schedule/prisma/schema.prisma
```

SIGTERM受信時、APIは新規受付停止、処理中request待機、Prisma disconnectの順で終了します。`SHUTDOWN_TIMEOUT_SECONDS`の既定は30秒です。ECS stop timeoutは45秒です。

## AWS staging準備

`infra/`はTypeScript AWS CDKです。通常の`synth`は課金やAWS変更を行わず、domain未設定でも検査できます。

```bash
pnpm --filter @oshi-schedule/infra typecheck
pnpm --filter @oshi-schedule/infra test
pnpm --filter @oshi-schedule/infra synth
pnpm validate:yaml -- docs/api/openapi.yaml amplify.yml .github/workflows/*.yml
```

実`cdk deploy`はこのREADMEから直接開始せず、[staging構築チェックリスト](docs/operations/staging-setup.md)と[AWS bootstrap](docs/operations/aws-bootstrap.md)に従ってください。RDS、ALB、public IPv4はstagingでも主要固定費です。AWS resourceはまだ作成されていません。

## 構成

```text
apps/web       Next.js App Router + MUI + Supabase PKCE
apps/api       Express REST API、同期use case、Prisma/Google/YouTube adapter
apps/worker    クラウド非依存の定期同期CLI
packages/shared             Zod契約・型・定数
packages/eslint-config      共通lint
packages/typescript-config  共通TypeScript設定
prisma          schema、完全な初期migration、seed
docs            日本語の要件・設計書
e2e             Playwrightシナリオ
infra           AWS CDK stack、environment validation、assertion test
scripts         YAML検証、ECS revision更新、staging smoke test
.github/workflows  CI、gated staging deploy、manual production deploy
```

設計の入口は [プロダクト要件](docs/requirements/product-requirements.md)、[システム概要](docs/architecture/system-overview.md)、[同期設計](docs/architecture/synchronization.md)、[API仕様](docs/api/api-specification.md)、[セキュリティ方針](docs/security/security-policy.md) です。AWS運用は[デプロイ構成](docs/architecture/deployment-architecture.md)、[staging構築](docs/operations/staging-setup.md)、[GitHub Actions](docs/operations/github-actions.md)を参照してください。

## 本番前の注意

Fake認証と既知の開発用暗号鍵は `production` で起動できません。実Google/Supabase/YouTube接続、OAuth審査、scheduler/Secret Manager/監視、DB backup、鍵ローテーション手順、負荷・クォータ試験を本番環境で確認してください。`/terms` と `/privacy` の文面は開発・動作確認用のデモであり、一般公開前に専門家の確認を受けて正式版に差し替えてください。第三者向けYouTube Data APIだけでプレミア公開を確定できない項目は、誤推測せず「種別未確定」として扱います。

Webのproduction buildでは `NEXT_PUBLIC_API_URL`、`NEXT_PUBLIC_DEMO_MODE=false`、`NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` を明示してください。`NEXT_PUBLIC_*` はブラウザーへ公開されるため、service role key、OAuth client secret、暗号鍵などの秘密値を設定してはいけません。

Next.js開発サーバーのアクセスログはOAuth callbackのquery stringを表示する場合があるため、開発ログも機密情報として扱い、共有・永続保存しないでください。アプリケーションloggerはOAuth credentialとBearer値を共通サニタイズします。本番のreverse proxy・CDN・platform access logではquery stringを保存せず、`/auth/callback`はpathnameとHTTP statusだけを記録してください。
