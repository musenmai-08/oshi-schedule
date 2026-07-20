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

## 資格情報なしで起動（Fakeモード）

ターミナルを2つ使用します。

```bash
# terminal 1
APP_MODE=fake ALLOWED_EMAILS=developer@example.com pnpm --filter @oshi-schedule/api dev

# terminal 2
NEXT_PUBLIC_DEMO_MODE=true NEXT_PUBLIC_API_URL=http://localhost:4000 pnpm --filter @oshi-schedule/web dev
```

ブラウザーで `http://localhost:3000` を開き、「Googleでログイン」（デモでは外部通信なし）を押します。Fakeモードの状態はAPIプロセスのメモリ上にあり、再起動で初期化されます。

定期 worker の入口もFakeで確認できます。

```bash
APP_MODE=fake ALLOWED_EMAILS=developer@example.com pnpm sync:scheduled
```

## MySQL / 実サービスモード

```bash
docker compose up -d mysql
pnpm db:generate
pnpm db:migrate
pnpm db:seed
```

`.env.example` をコピーし、次を実値に置き換えます。

- `DATABASE_URL`
- `ALLOWED_EMAILS`（カンマ区切り）
- Supabase URL、publishable key、service role key
- Google OAuth client ID / secret
- YouTube Data API key
- `TOKEN_ENCRYPTION_KEYS`（32 byte乱数のbase64。例: `openssl rand -base64 32`）

Supabase の Google provider に Calendar API scope を許可し、Site URL/redirect URL に `http://localhost:3000/auth/callback` を登録してください。Google Cloud 側でも同じ Supabase callback URI、YouTube Data API v3、Google Calendar API、OAuth同意画面を設定します。

```bash
# terminal 1
APP_MODE=real pnpm --filter @oshi-schedule/api dev

# terminal 2
NEXT_PUBLIC_DEMO_MODE=false pnpm --filter @oshi-schedule/web dev

# scheduler / terminal 3
APP_MODE=real pnpm sync:scheduled
```

1時間ごとの実行はインフラのschedulerから `pnpm sync:scheduled` を呼びます。worker はHTTPサーバーを必要としません。

## 品質確認

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm exec playwright install chromium  # 初回のみ
pnpm test:e2e
```

APIの確認例:

```bash
curl http://localhost:4000/health
curl -H 'Authorization: Bearer demo-token' http://localhost:4000/api/v1/channels
```

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
```

設計の入口は [プロダクト要件](docs/requirements/product-requirements.md)、[システム概要](docs/architecture/system-overview.md)、[同期設計](docs/architecture/synchronization.md)、[API仕様](docs/api/api-specification.md)、[セキュリティ方針](docs/security/security-policy.md) です。

## 本番前の注意

Fake認証は `production` で起動できません。実Google/Supabase/YouTube接続、OAuth審査、利用規約・プライバシーポリシーの公開、scheduler/Secret Manager/監視、DB backup、鍵ローテーション手順、負荷・クォータ試験を本番環境で確認してください。
