# 認証・Google OAuth 設計

## フロー

1. Web は Supabase `signInWithOAuth` を `flowType: pkce`、Google scope `openid`、`userinfo.email`、`userinfo.profile`、`https://www.googleapis.com/auth/calendar.app.created`、`access_type=offline`、`prompt=consent` で開始する。過去の広いCalendar grantを新tokenへ結合しないため、`include_granted_scopes=false`を明示する。
2. callback で一回限り・5 分有効の code を `exchangeCodeForSession` に交換する。
3. Web は Supabase access JWT と、その応答でのみ得られる `provider_refresh_token` を onboarding API へ TLS で送る。短期の`provider_token`は使用・転送・保存しない。ブラウザーの永続ストレージへGoogle tokenを保存しない。
4. callback の初回設定失敗・refresh token不足・scope不足は固定値 `setup=failed|reauth` だけでダッシュボードへ通知し、画面表示後にqueryを除去する。任意のquery文字列や外部API応答は表示しない。ダッシュボードとSettingsは `/me` のonboarding、Calendar、再認証状態を読み、確認中・接続済み・未完了・再認証・取得失敗を区別する。
5. API は JWT 署名を Supabase JWKS で検証し、`iss`、`aud=authenticated`、`exp`、`sub`、email を検証する。招待外メールは拒否する。
6. APIは受領したrefresh tokenをGoogle token endpointで一度交換し、応答の実付与`scope`を検査する。identity 3種と`calendar.app.created`が揃い、ほかのCalendar scopeがない場合だけ、正規化した実scopeとAES-256-GCM暗号文を保存してonboardingを進める。不足・旧grant混入時は`reauthRequired=true`とし、credentialを更新せず再同意へ誘導する。access tokenはメモリ内で短期利用後に破棄する。Supabase はGoogle provider tokenを更新しないため、workerは保存済みrefresh tokenから更新し、更新応答でも同じscope契約を再検査する。

暗号文形式は `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url)。鍵は `TOKEN_ENCRYPTION_KEYS` に `keyId:base64(32 bytes)` の列として置き、先頭を暗号化、全鍵を復号候補にする。real/productionは厳密なbase64・復号後32 byteを要求し、開発sample、全ゼロ、単一byte、短周期、連番など予測可能な鍵を拒否する。この拒否規則自体をentropy保証とはせず、鍵は`openssl rand -base64 32`等のOS CSPRNGで生成してSecret Managerから注入する。暗号化ごとに96-bit IVを生成し、GCM authentication tagを検証する。ローテーションは新鍵を先頭、旧鍵を復号候補として併存させ、復号後に新鍵で再暗号化してから旧鍵を廃止する。不明key IDや誤ったtagは平文・鍵をログせず固定エラーで失敗する。

## Cookie・CSRF

Supabase SSR cookie はブラウザーでの session refresh に使うため HttpOnly を前提にしない。Supabase が設定する Secure/SameSite 属性を本番で確認し、CSP と短い JWT 寿命を併用する。状態変更 API は Bearer JWT を要求し CORS origin を限定するため、通常の cookie CSRF 対象外。OAuth state と PKCE verifier は Supabase SSR へ委譲する。

## 公式仕様確認（2026-07-20）

- [Supabase Google login](https://supabase.com/docs/guides/auth/social-login/auth-google): provider refresh token 取得には offline access 等が必要。
- [Supabase PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow): code は一回限り・短時間有効。
- [Supabase JWT](https://supabase.com/docs/guides/auth/jwts): project JWKS による署名検証を採用。
- [Google OAuth web server](https://developers.google.com/identity/protocols/oauth2/web-server): バックグラウンド利用には offline access と refresh token の安全な保存が必要。

## 再認証・削除

OAuth token endpoint の `invalid_grant`、必須scope不足、`calendar.app.created`以外のCalendar scope混入を恒久的な再同意対象として `reauthRequired=true` にし、429/5xx/network/timeoutは `OAUTH_RETRY_BASE_DELAY_MS` を基準にexponential backoff+jitter、`Retry-After`を考慮し `OAUTH_RETRY_MAX_DELAY_MS` で上限を付けて最大3回再試行する。定期 worker は再認証状態の User を対象外とし、再連携成功時に解除する。

ローカル User の暗黙作成は onboarding だけが行う。通常 API は既存の active User を要求し、`AccountDeletionRequest.supabaseUserId` の墓石がある主体を 410 で拒否する。削除は要求を先に永続化し、Calendar 削除→Google revoke→User 固有データ削除→Supabase Admin 削除→完了の各時刻を保存する。User FK はSetNullなのでローカル削除後も墓石が残り、同じJWTによる再実行は削除処理だけを継続できる。

Calendar、OAuth revoke、Supabase Admin DELETEはすべて `EXTERNAL_API_TIMEOUT_MS` のAbortSignalでHTTP自体を中断する。timeoutは専用のretryable error codeを墓石へ保存し、response bodyやtokenは保存しない。404/410のCalendar、400の既失効token、404のSupabase userは冪等成功とする。

同時削除はsubject単位のDB leaseで直列化する。leaseはowner、DB時刻による期限、単調増加versionを持つ。各外部呼出しの前後とstep書込み時にowner/version/有効期限を確認し、期限後に後継が取得した場合は古い実行主体のstep/FAILED書込みと解放を拒否する。外部呼出し中にDB transactionは保持しない。`ACCOUNT_DELETION_LEASE_MS` は外部timeoutより長くなければ起動設定検証に失敗する。
