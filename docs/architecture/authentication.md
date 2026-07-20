# 認証・Google OAuth 設計

## フロー

1. Web は Supabase `signInWithOAuth` を `flowType: pkce`、Google scope `https://www.googleapis.com/auth/calendar`、`access_type=offline`、`prompt=consent` で開始する。
2. callback で一回限り・5 分有効の code を `exchangeCodeForSession` に交換する。
3. Web は Supabase access JWT と、その応答でのみ得られる `provider_refresh_token` / `provider_token` を onboarding API へ TLS で送る。ブラウザーの永続ストレージへ provider token を保存しない。
4. API は JWT 署名を Supabase JWKS で検証し、`iss`、`aud=authenticated`、`exp`、`sub`、email を検証する。招待外メールは拒否する。
5. refresh token を AES-256-GCM で暗号化保存し、access token は短期利用後に破棄する。Supabase は Google provider token を更新しないため、worker は保存済み refresh token から更新する。

暗号文形式は `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url)。鍵は `TOKEN_ENCRYPTION_KEYS` に `keyId:base64(32 bytes)` の列として置き、先頭を暗号化、全鍵を復号候補にする。

## Cookie・CSRF

Supabase SSR cookie は `HttpOnly`、本番 `Secure`、`SameSite=Lax`。状態変更 API は Bearer JWT を要求し CORS origin を限定するため、通常の cookie CSRF 対象外。OAuth state と PKCE verifier は Supabase SSR に委譲し、callback の `next` は内部パスだけ許可する。

## 公式仕様確認（2026-07-20）

- [Supabase Google login](https://supabase.com/docs/guides/auth/social-login/auth-google): provider refresh token 取得には offline access 等が必要。
- [Supabase PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow): code は一回限り・短時間有効。
- [Supabase JWT](https://supabase.com/docs/guides/auth/jwts): project JWKS による署名検証を採用。
- [Google OAuth web server](https://developers.google.com/identity/protocols/oauth2/web-server): バックグラウンド利用には offline access と refresh token の安全な保存が必要。

## 再認証・削除

`invalid_grant` / 401 で `reauthRequired=true` とし自動再試行を止める。削除 API は Calendar 削除→Google revoke→credential/関連削除→Supabase Admin 削除を同じ確認入力で再要求でき、404/既失効を成功扱いにする。`AccountDeletionRequest` は非同期補償処理へ移行するためのモデルとして用意したが、MVP API は同期実行である。Supabase Admin 削除だけがローカル削除後に失敗した場合の補償 worker は本番公開前に追加する。
