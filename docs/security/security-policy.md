# セキュリティ方針

- 認証: Supabase JWKS で署名・algorithm・issuer・audience・expiry を検証。`sub` のみを主体 ID とする。Fake auth は `NODE_ENV=production` で禁止。
- 認可: repository query に user ID を必須化し IDOR を防ぐ。subscription path は CUID として検証する。削除は確認文字 `DELETE` と永続墓石を要求し、削除中・削除済み主体の通常 API 利用を拒否する。
- token: Google refresh token は AES-256-GCM、鍵は環境変数/本番 Secret Manager。鍵 ID 付き ciphertext によりローテーションする。real/production はkey IDに関係なく全ゼロ・反復byte等の低entropy鍵を拒否し、重複key IDも起動時拒否する。96-bit IVは暗号化ごとに生成しauthentication tagを必ず検証する。tokenはログ・応答へ出さない。
- HTTP: Helmet、origin allowlist CORS、32 KiB JSON、request ID、認証 API 100 req/15min、手動同期 1 req/5min。Bearer 認証で cookie CSRF を避ける。
- 外部通信: HTTPS、`EXTERNAL_API_TIMEOUT_MS` のAbortSignalで実HTTPを中断し、timeoutを通常API errorと別codeにする。本文をログしない。redirect は相対パス allowlist。Google OAuth state/PKCE を必須とする。
- データ: Prisma parameterization で SQL injection を防ぎ、React escape でXSSを低減する。APIはJSON専用でCSPを無効化しているため、Web側CSPは本番公開前の別途hardening項目とする。メールはログに含めない。
- 設定: Zod で起動時検証し、本番で DB、Supabase、Google、YouTube、強い暗号鍵が不足・既知defaultなら fail fast。root `.env` はAPI/workerの実行cwdに依存せず明示pathから読む。

## ログ

JSON 構造化ログにlevel/time/requestId/runId/errorCodeを記録する。YouTube quotaはmethod/bucket/予約unit/使用unit/残unitを記録する。秘密値、Authorization、メール、API key、外部応答全体は禁止。利用者向けには安定したerror code、安全な日本語メッセージ、quota延期時の次回時刻だけを返し、内部unit数は返さない。

アカウント削除の墓石はメールではなくSupabase user IDを一意キーとし、User削除後も保持する。Supabase Admin削除後の既発行JWTは署名上有効な間も墓石照合で410にし、ブラウザーは204受領後にsignOutする。削除errorには安全な固定codeだけを保存し、外部response本文は保存しない。削除leaseはDB時刻、owner、versionによるfencingを使い、古いownerのstep/FAILED書込みと解放を拒否する。

## Google 公開審査前チェック

OAuth 同意画面、ブランド検証、最小 scope (`calendar`)、利用規約、プライバシーポリシー、データ削除 URL、API 利用目的の説明・デモ動画を準備する。開発/本番 Google Cloud project、redirect URI、Supabase project を分離し、テストユーザー制限を解除する前に Google API Services User Data Policy を確認する。

## 脆弱性報告

公開 issue に機密情報を書かず、運営者の非公開連絡先へ再現手順と影響を報告する。MVP 公開前に連絡先を README とサイトへ掲載する。
