# ディレクトリ構成

```text
apps/
  web/       Next.js App Router、MUI、Supabase client
  api/src/
    presentation/  route・middleware・HTTP schema
    application/   use case・port
    domain/        純粋ロジック・error
    infrastructure/Prisma・Google・YouTube・JWT・暗号・logger
  worker/    定期同期 CLI
packages/
  shared/    Zod API 契約・型・定数
  eslint-config/   共通 flat config
  typescript-config/共通 tsconfig
prisma/      schema・migration・seed
docs/        要件・設計・運用資料
e2e/        Playwright シナリオ
```

依存方向は presentation → application → domain。infrastructure は application の port を実装し、composition root だけが具象を結線する。Web は API の内部コードを import しない。
