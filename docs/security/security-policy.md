# セキュリティ方針

- 認証: Supabase JWKS で署名・algorithm・issuer・audience・expiry を検証。`sub` のみを主体 ID とする。Fake auth は `NODE_ENV=production` で禁止。
- 認可: repository query に user ID を必須化し IDOR を防ぐ。削除は確認文字 `DELETE` と二重送信ロックを要求する。
- token: Google refresh token は AES-256-GCM、鍵は環境変数/本番 Secret Manager。鍵 ID 付き ciphertext によりローテーションする。token はログ・応答へ出さない。
- HTTP: Helmet、origin allowlist CORS、32 KiB JSON、request ID、認証 API 100 req/15min、手動同期 1 req/5min。Bearer 認証で cookie CSRF を避ける。
- 外部通信: HTTPS、10 秒 timeout、本文をログしない。redirect は相対パス allowlist。Google OAuth state/PKCE を必須とする。
- データ: Prisma parameterization で SQL injection を防ぎ、React escape と CSP で XSS を低減。メールはログに含めない。
- 設定: Zod で起動時検証し、本番で DB、Supabase、Google、YouTube、暗号鍵不足なら fail fast。

## ログ

JSON 構造化ログに level/time/requestId/syncRunId/errorCode を記録する。秘密値、Authorization、メール、外部応答全体は禁止。利用者向けには安定した error code と安全な日本語メッセージだけを返す。

## Google 公開審査前チェック

OAuth 同意画面、ブランド検証、最小 scope (`calendar`)、利用規約、プライバシーポリシー、データ削除 URL、API 利用目的の説明・デモ動画を準備する。開発/本番 Google Cloud project、redirect URI、Supabase project を分離し、テストユーザー制限を解除する前に Google API Services User Data Policy を確認する。

## 脆弱性報告

公開 issue に機密情報を書かず、運営者の非公開連絡先へ再現手順と影響を報告する。MVP 公開前に連絡先を README とサイトへ掲載する。
