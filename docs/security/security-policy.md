# セキュリティ方針

- 認証: Supabase JWKS で署名・algorithm・issuer・audience・expiry を検証。`sub` のみを主体 ID とする。Fake auth は `NODE_ENV=production` で禁止。
- 認可: repository query に user ID を必須化し IDOR を防ぐ。subscription path は CUID として検証する。削除は確認文字 `DELETE` と永続墓石を要求し、削除中・削除済み主体の通常 API 利用を拒否する。
- token: Google refresh token は AES-256-GCM、鍵はOS CSPRNGで32 byte生成し本番Secret Managerから注入する。鍵 ID 付き ciphertext と新旧鍵併存により再暗号化rotationする。real/production は厳密なbase64/長さ、既知sample、短周期、連番、極端に少ないbyte種類、重複key IDを起動時拒否するが、独自entropy推定を強度保証にはしない。96-bit IVは暗号化ごとに生成しauthentication tagを必ず検証する。不明version/誤鍵は安全に失敗し、token・鍵はログ/応答へ出さない。
- HTTP: Helmet、origin allowlist CORS、32 KiB JSON、request ID、認証 API 100 req/15min、手動同期 1 req/5min。Bearer 認証で cookie CSRF を避ける。APIはJSON専用なのでdocument CSPを送らず、WebがCSPを所有する。TLS終端はdeployment edgeの責務とし、ローカルHTTPへHSTSを送らない。本番のHSTSはHTTPS強制後にedgeへ設定する。`/health`はliveness、`/ready`は秘密を含まないDB readinessとして分離する。
- 外部通信: HTTPS、`EXTERNAL_API_TIMEOUT_MS` のAbortSignalで実HTTPを中断し、timeoutを通常API errorと別codeにする。本文をログしない。redirect は相対パス allowlist。Google OAuth state/PKCE を必須とする。
- データ: Prisma parameterization で SQL injection を防ぎ、React escape でXSSを低減する。Webのproduction responseは`default-src 'self'`、`object-src 'none'`、`frame-ancestors 'none'`を基準に、`connect-src`を設定済みAPI/Supabase originへ限定する。YouTube thumbnail表示のため`img-src https:`、Next.js/MUIの生成styleとbootstrap scriptのため`unsafe-inline`をstyle/scriptに限定して許可するが、`unsafe-eval`と`*`は許可しない。nonce/hash方式はrendering・CDN構成確定後に導入し、`unsafe-inline`を縮小する。メールはログに含めない。
- 設定: Zod で起動時検証し、本番で DB、Supabase、Google、YouTube、強い暗号鍵が不足・既知defaultなら fail fast。root `.env` はAPI/workerの実行cwdに依存せず明示pathから読む。

## rate limitのデプロイ制約

現在のAPI rate limitは`express-rate-limit`のprocess memory storeを使う。`TRUST_PROXY_HOPS`は整数で、local/testの既定値0はproxyを信頼せず、API Gateway/VPC Linkの1段を通るstaging/productionは1とする。無条件の`true`は禁止し、ECS taskのsecurity groupはVPC Link SGからport 4000だけを許可する。左端`X-Forwarded-For`をclientが変えてもrate limit identityを回避できないことをtestする。複数instanceではカウンターが共有されないため、desired countを2以上にする前にRedis/Valkey等のatomicな共有storeを導入する。

## ログ

JSON 構造化ログにlevel/time/requestId/runId/errorCodeを記録する。YouTube quotaはmethod/bucket/予約unit/使用unit/残unitを記録する。秘密値、Authorization、メール、API key、外部応答全体は禁止。利用者向けには安定したerror code、安全な日本語メッセージ、quota延期時の次回時刻だけを返し、内部unit数は返さない。

アプリケーションloggerは構造化フィールドと文字列内URLを共通サニタイズし、`code`、`access_token`、`refresh_token`、`token`、`authorization`、`client_secret`とBearer値を記録しない。OAuth callbackを追跡するときはパス、HTTP status、requestIdだけを記録し、URL全文やquery stringを渡さない。安全なアプリケーション分類は`code`ではなく`errorCode`へ記録する。

Next.js開発サーバーは内部アクセスログへrequest targetを出力するため、OAuth callbackの一回限りの`code`を含むquery stringが表示されることがある。この内部ログへアプリのサニタイズ処理は適用できないため、開発stdout/stderrを機密情報として扱い、共有・永続保存しない。Next.js 15.5.20の`next start`では合成query付きrequestを標準出力へ記録しないことを確認済みだが、本番のreverse proxy、CDN、platform access logは別管理である。これらはquery stringを保存しない設定とし、OAuth callbackはpathnameとstatusだけを記録する。Next.jsやホスティング基盤の更新時は、本番相当起動でcallback queryが出力されないことを再確認する。

アカウント削除の墓石はメールではなくSupabase user IDを一意キーとし、User削除後も保持する。Supabase Admin削除後の既発行JWTは署名上有効な間も墓石照合で410にし、ブラウザーは204受領後にsignOutする。削除errorには安全な固定codeだけを保存し、外部response本文は保存しない。削除leaseはDB時刻、owner、versionによるfencingを使い、古いownerのstep/FAILED書込みと解放を拒否する。

## Google Calendar scope最小化

現行は`https://www.googleapis.com/auth/calendar`を要求する。Google公式のscope一覧と各API methodのauthorization欄では、`https://www.googleapis.com/auth/calendar.app.created`が、アプリが作成したsecondary calendarの作成・取得・更新・削除と、そのcalendar内のevent取得・作成・更新・削除に利用できる。このアプリのGateway操作と、利用者が削除したeventを`events.get`の404後に再作成する処理を満たすため、推奨候補は`calendar.app.created`である。

今回はscopeを変更しない。Supabase Google provider側の許可scope、OAuth同意画面、既存refresh tokenが持つgrantを同時に移行できず、`calendar.app.created`での再同意と全Gateway操作をstagingで検証していないためである。現行`calendar`はユーザーがアクセスできる全calendarを対象にできる一方、候補scopeはアプリ作成calendarだけに限定される。現在のOAuth requestは`include_granted_scopes=true`なので、同じGoogle projectへ過去に許可した広いscopeが再同意後のtokenへ結合され得る。また、APIはprovider access tokenの実付与scopeを検査せず、DBへrequest側の固定scopeを保存する。productionの一般公開前に、Google Cloud/Supabase設定、過去grantのない利用者または明示revoke後の再同意、実付与scope、保存scope、作成・取得・event CRUD・calendar削除・削除event復旧をstagingで確認し、OAuth審査資料を限定scopeに合わせる。現行scopeを維持する場合は、最小scopeで代替できない根拠とGoogle側の審査状態をrelease gateへ記録する。

公式根拠: [Calendar API scopes](https://developers.google.com/workspace/calendar/api/auth)、[calendars.insert](https://developers.google.com/workspace/calendar/api/v3/reference/calendars/insert)、[calendars.get](https://developers.google.com/workspace/calendar/api/v3/reference/calendars/get)、[calendars.delete](https://developers.google.com/workspace/calendar/api/v3/reference/calendars/delete)、[events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)、[events.get](https://developers.google.com/workspace/calendar/api/v3/reference/events/get)、[events.patch](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch)、[events.delete](https://developers.google.com/workspace/calendar/api/v3/reference/events/delete)。

## Google 公開審査前チェック

OAuth 同意画面、ブランド検証、最小scope候補（`calendar.app.created`）、利用規約、プライバシーポリシー、データ削除 URL、API 利用目的の説明・デモ動画を準備する。開発/本番 Google Cloud project、redirect URI、Supabase project を分離し、テストユーザー制限を解除する前に Google API Services User Data Policy を確認する。

## 脆弱性報告

公開 issue に機密情報を書かず、運営者の非公開連絡先へ再現手順と影響を報告する。MVP 公開前に連絡先を README とサイトへ掲載する。

## Container脆弱性例外

修正版のないDebian package CVEだけを、CVE単位・期限付き・根拠付きで一時的にリスク受容する。修正可能なCVE、Node/application依存、理由や期限のない例外、`--ignore-unfixed`による一括除外は禁止する。現在の例外、mitigation、承認、失効後の再評価手順は[Container vulnerability exception registry](./container-vulnerability-exceptions.md)で管理する。
