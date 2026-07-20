# テスト方針

- Unit (Vitest): 招待判定、handle、上限、正規化、種別、仮終了、event builder、hash 差分、同期対象、再認証、削除状態を固定 Clock と Fake port で検証する。
- API integration (Vitest + Supertest): auth、招待外、登録/重複/上限、pause/resume、削除、rate limit、所有権、account deletion を in-memory store/Fake gateway で観察する。
- E2E (Playwright): `NEXT_PUBLIC_DEMO_MODE=true` と Fake API を用い、dashboard→検索→登録→停止/再開→同期→削除を行う。実 Google/YouTube へは送らない。
- Prisma: migration と生成を CI で検査し、`TEST_DATABASE_URL` を指定した Docker MySQL integration で実CUID endpoint、所有権、並列3件上限、削除墓石、DB leaseを検証する。テストschema/DBはsuiteまたはCI job単位で分離する。

品質ゲートは `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:e2e`。sleep ではなく UI/API の観察可能状態を待つ。coverage は主要 domain/application 80% を目標とし、行数だけを完了条件にしない。

Critical/High修正では、固定Clockとfault injectionを使い、削除段階再開・同時実行、未来eventだけの削除、配信終了、Calendar 404、決定的event ID、同期lease/履歴/stale回収、OAuth error分類・上限付き再試行、暗号鍵、実MySQL CUID/競合を回帰検証する。E2EはFake auth/YouTube/Calendarを利用し外部APIを呼ばない。実資格情報の受入はstaging checklistとして別管理する。2026-07-20の修正完了時は通常43件、MySQL専用4件、E2E 1件の合計48件が成功した。
