# テスト方針

- Unit (Vitest): 招待判定、handle、上限、正規化、種別、仮終了、event builder、hash 差分、同期対象、再認証、削除状態を固定 Clock と Fake port で検証する。
- API integration (Vitest + Supertest): auth、招待外、登録/重複/上限、pause/resume、削除、rate limit、所有権、account deletion を in-memory store/Fake gateway で観察する。
- E2E (Playwright): `NEXT_PUBLIC_DEMO_MODE=true` と Fake API を用い、dashboard→検索→登録→停止/再開→同期→削除を行う。実 Google/YouTube へは送らない。
- Prisma: migration と生成を CI で検査し、DB integration は Docker MySQL のテスト schema を毎 suite 分離する。

品質ゲートは `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:e2e`。sleep ではなく UI/API の観察可能状態を待つ。coverage は主要 domain/application 80% を目標とし、行数だけを完了条件にしない。

2026-07-20 のMVP検証では unit/API integration 10件、Chromium E2E 1シナリオが成功した。E2Eは Fake auth/YouTube/Calendar を利用し外部 API を呼んでいない。
