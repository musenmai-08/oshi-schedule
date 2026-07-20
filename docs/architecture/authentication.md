# 認証・Google OAuth 設計

## フロー

1. Web は Supabase `signInWithOAuth` を `flowType: pkce`、Google scope `https://www.googleapis.com/auth/calendar`、`access_type=offline`、`prompt=consent` で開始する。
2. callback で一回限り・5 分有効の code を `exchangeCodeForSession` に交換する。
3. Web は Supabase access JWT と、その応答でのみ得られる `provider_refresh_token` / `provider_token` を onboarding API へ TLS で送る。ブラウザーの永続ストレージへ provider token を保存しない。
4. API は JWT 署名を Supabase JWKS で検証し、`iss`、`aud=authenticated`、`exp`、`sub`、email を検証する。招待外メールは拒否する。
5. refresh token を AES-256-GCM で暗号化保存し、access token は短期利用後に破棄する。Supabase は Google provider token を更新しないため、worker は保存済み refresh token から更新する。

暗号文形式は `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url)。鍵は `TOKEN_ENCRYPTION_KEYS` に `keyId:base64(32 bytes)` の列として置き、先頭を暗号化、全鍵を復号候補にする。

## Cookie・CSRF

Supabase SSR cookie はブラウザーでの session refresh に使うため HttpOnly を前提にしない。Supabase が設定する Secure/SameSite 属性を本番で確認し、CSP と短い JWT 寿命を併用する。状態変更 API は Bearer JWT を要求し CORS origin を限定するため、通常の cookie CSRF 対象外。OAuth state と PKCE verifier は Supabase SSR へ委譲する。

## 公式仕様確認（2026-07-20）

- [Supabase Google login](https://supabase.com/docs/guides/auth/social-login/auth-google): provider refresh token 取得には offline access 等が必要。
- [Supabase PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow): code は一回限り・短時間有効。
- [Supabase JWT](https://supabase.com/docs/guides/auth/jwts): project JWKS による署名検証を採用。
- [Google OAuth web server](https://developers.google.com/identity/protocols/oauth2/web-server): バックグラウンド利用には offline access と refresh token の安全な保存が必要。

## 再認証・削除

OAuth token endpoint の `invalid_grant` だけを恒久失効として `reauthRequired=true` にし、429/5xx/network error は指数的delay付き最大3回の一時障害再試行とする。定期 worker は再認証状態の User を対象外とし、再連携成功時に解除する。

ローカル User の暗黙作成は onboarding だけが行う。通常 API は既存の active User を要求し、`AccountDeletionRequest.supabaseUserId` の墓石がある主体を 410 で拒否する。削除は要求を先に永続化し、Calendar 削除→Google revoke→User 固有データ削除→Supabase Admin 削除→完了の各時刻を保存する。User FK は SetNull なのでローカル削除後も墓石が残り、同じ JWT による再実行は削除処理だけを継続できる。同時リクエストはsubject単位のDB leaseで直列化し、競合側は409を返す。404/410 の Calendar と既失効 token は冪等成功として扱い、外部呼び出し中は DB transaction を保持しない。
