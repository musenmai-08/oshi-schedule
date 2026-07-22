# テスト方針

- Unit (Vitest): 招待判定、handle、上限、正規化、種別、仮終了、event builder、hash 差分、同期対象、再認証、削除状態を固定 Clock と Fake port で検証する。
- API integration (Vitest + Supertest): auth、招待外、登録/重複/上限、pause/resume、削除、rate limit、所有権、account deletion を in-memory store/Fake gateway で観察する。
- E2E (Playwright): `NEXT_PUBLIC_DEMO_MODE=true` と Fake APIを専用Web/API port（既定3310/4310）で毎回起動し、既存serverは再利用しない。固有health identity確認後、dashboard→検索→登録→停止/再開→同期→削除を行う。実 Google/YouTube へは送らない。並列CIはjobごとに`E2E_WEB_PORT/E2E_API_PORT`を割り当てる。
- Prisma: migration と生成を CI で検査し、`TEST_DATABASE_URL` を指定した Docker MySQL integration で実CUID endpoint、所有権、並列3件上限、削除墓石、fencing lease、YouTube quotaの並行予約を検証する。テストschema/DBはsuiteまたはCI job単位で分離する。

品質ゲートは `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:e2e`。sleep ではなく UI/API の観察可能状態を待つ。coverage は主要 domain/application 80% を目標とし、行数だけを完了条件にしない。

Critical/High修正では、固定Clockとfault injectionを使い、削除timeout・段階再開・stale writer、過去配信の状態×mapping表、LIVEの仮終了超過、Calendar 404、決定的event ID、lease fencing、snapshot fan-out、同期phase/runId、OAuth backoff/Retry-After、暗号鍵sample/周期/連番/tamper/rotation、quota追跡上限/期間/batch/予約/retry/page/date境界/cache/延期を回帰検証する。MySQLでは2 worker/2 userの同一channel実並行同期、期限切れlease takeover、30並列quota予約を実transactionで検査する。E2EはFake auth/YouTube/Calendarを利用し外部APIを呼ばない。実資格情報の受入はstaging checklistとして別管理し、最新件数と実行結果は[最終監査修正台帳](../reviews/final-audit-remediation.md)へ記録する。

2026-07-20の再監査修正完了時点では、Node 22.23.1のclean install後にTurbo cacheを無効化し、通常69件、Docker MySQL 6件、Playwright E2E 1件の計76件が成功した。typecheck 6/6、lint 6/6、build 4/4、Fake scheduled worker、既存/空DB migrationとschema diffも成功した。

2026-07-22の最終監査修正では、同じclean install条件で通常96件、Docker MySQL 7件、Playwright E2E 1件の計104件が成功した。E2Eは3000番の別アプリ稼働下と連続2回を追加確認し、終了後の専用port listenerなしも検査した。typecheck/lint/buildはTurbo cacheなし、既存/空DBは全5 migrationとschema差分なしを確認した。
