# High 2 production OAuth・法務表示 詳細監査

- 実施日: 2026-08-27
- 対象: Google OAuth / Calendar scope、Google Calendar Gateway、公開ホーム、利用規約、プライバシーポリシー、production公開審査準備
- 更新: 2026-08-27にscope最小化コードを実装し、2026-08-28に中断差分のレビューと検証を完了した。AWS、Google Cloud、Supabase、DB実データ、OAuth grantは変更しておらず、AWS APIも呼び出していない。

## 判定

**High 2は未解消であり、production一般公開のblockerである。**

Calendar scopeのコードは`https://www.googleapis.com/auth/calendar.app.created`へ統一した。incremental grantを無効化し、実refresh tokenのgrantを検証・保存して、旧Calendar scope混入や必須scope不足を再同意へ分類する。外部設定変更とdeployは未実施であり、既存grantの縮小とstagingでの全操作受入もまだ完了していない。

規約・Privacyはrouteと公開URLを持つが、公開中のstagingページにもデモ警告と未確定文言が残る。production domain、運営者・問い合わせ先、保存期間、Limited Useを含む正式文面、Google Cloudのproduction project・branding・data access・verification状態も未確定である。

## 確認した公開URL

2026-08-27に次のstaging URLが認証不要でHTTP 200を返すことを確認した。

- `https://staging.oshi-schedule.com/terms`
- `https://staging.oshi-schedule.com/privacy`

どちらにも「開発・動作確認用のデモ文面」が表示される。Termsには未定の問い合わせ先、Privacyには未定の問い合わせ先、保存期間、Limited Use準拠確認の予告が残る。

productionの実URLは未確定である。文書内の`https://app.example.com`はplaceholderであり、test fixtureの`app.oshi-schedule.com`もproduction決定値ではない。production domain決定後、同一origin上の次のURLを公開し、Google CloudのApp domainと一致させる。

- `https://<production-web-origin>/`
- `https://<production-web-origin>/terms`
- `https://<production-web-origin>/privacy`

## 現在のOAuth scopeとgrant管理

| 層                           | 実装後の状態                                                                      | 残確認                                                              |
| ---------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Web OAuth request            | identity 3種 + `calendar.app.created`                                             | Google/Supabase実設定と同意画面は未変更・未確認                     |
| offline consent              | `access_type=offline`、`prompt=consent`                                           | background同期用refresh token取得に必要                             |
| incremental grant            | `include_granted_scopes=false`                                                    | 旧grantを持たない利用者または明示revoke後の実同意で確認する         |
| callback                     | `provider_refresh_token`だけをonboarding APIへ送信                                | 未使用だったprovider access tokenの転送・API schemaを削除           |
| API grant validation         | refresh token交換応答の実`scope`を検証                                            | 実token応答と匿名化DB照合はstaging受入待ち                          |
| DB `GoogleCredential.scopes` | 検証済み実scopeを重複除去・sortしたspace-separated文字列で保存                    | 既存行は再同意成功まで旧記録のまま                                  |
| 拒否                         | identity不足、app-created不足、app-created以外のCalendar scope混入を401再同意扱い | callbackは`setup=reauth`へ誘導し、失敗grantでcredentialを更新しない |

Google公式はaccess token応答の`scope` fieldを調べるよう案内している。APIはSupabaseの短期provider access tokenを信頼材料にせず、実際に永続利用するrefresh tokenをGoogle token endpointで交換した応答を検証する。これにより保存credentialと検証対象を一致させる。token、実scopeの利用者情報、Google response全体はログへ出さない。

## Calendar API操作との照合

実Gatewayは`calendarList.list`、primary calendar、ACL、共有設定、free/busy、既存event一覧を使用しない。

| 実装上の操作                      | HTTP / method                             | `calendar.app.created`との適合                                     |
| --------------------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| 保存済み専用calendarの存在確認    | `GET /calendars/{id}`                     | 公式methodの許可scopeに含まれる                                    |
| 専用secondary calendar作成        | `POST /calendars`                         | 公式scopeの主要用途                                                |
| event存在・取消状態確認           | `GET /calendars/{id}/events/{eventId}`    | 公式methodの許可scopeに含まれる                                    |
| event更新・409復旧                | `PATCH /calendars/{id}/events/{eventId}`  | 公式methodの許可scopeに含まれる                                    |
| event作成・決定的ID作成           | `POST /calendars/{id}/events`             | 公式methodの許可scopeに含まれる                                    |
| subscription削除時の未来event削除 | `DELETE /calendars/{id}/events/{eventId}` | 公式methodの許可scopeに含まれる                                    |
| account削除時の専用calendar削除   | `DELETE /calendars/{id}`                  | 公式methodの許可scopeに含まれる                                    |
| access token更新                  | Google OAuth token endpoint               | Calendar API scopeのmethodではない。refresh tokenが持つgrantを継承 |
| account削除時のgrant revoke       | Google OAuth revoke endpoint              | Calendar API scopeのmethodではない                                 |

公式scope一覧では、旧実装の広い`calendar`は利用者がアクセス可能な全Calendarの参照・編集・共有・完全削除を許可する。一方、`calendar.app.created`はsecondary calendarの作成と、そのアプリ作成calendar内のevent参照・作成・変更・削除に限定される。Gatewayとの照合結果から、採用したCalendar用scopeは次である。

```text
https://www.googleapis.com/auth/calendar.app.created
```

Google sign-inに必要なidentity scopeはCalendar scopeとは別で、production Google Cloud projectではSupabaseの要件に従い`openid`、`userinfo.email`、`userinfo.profile`も正確に登録する。アプリはemail allowlistと主体識別を利用している。Google Cloud Consoleが表示するscope分類と必要な審査種別は、その時点のproduction projectで確認し、文書から推測しない。

## scope変更の実装結果

1. Web/API共有定数を作り、OAuth requestをidentity 3種と`calendar.app.created`へ統一した。
2. `include_granted_scopes=false`を回帰テストで固定した。実grantにapp-created以外のCalendar scopeが含まれれば、必要scopeが揃っていても拒否する。
3. APIは受領refresh tokenをGoogle token endpointで交換し、応答`scope`を検証する。検証成功後だけ暗号化tokenと正規化した実scopeを保存する。
4. 必須scope不足・旧grant混入は`GOOGLE_RECONSENT_REQUIRED`と`reauthRequired=true`へ分類し、callbackは`/dashboard?setup=reauth`へ誘導する。
5. 未使用だった`providerAccessToken`はcallback送信、API schema、OpenAPIから除いた。worker/APIが使うaccess tokenはrefresh交換で取得し、process memoryの短期cacheだけに保持する。
6. app-created calendarのget/create/deleteとevent get/insert/patch/deleteをGateway contract testで固定した。404/410、cancelled event、決定的ID競合の既存回帰テストも維持する。

外部設定、deploy、既存DB行、Google grantは変更していない。productionは新しいGoogle Cloud project/clientを使用し、production初回consentを限定scopeだけで開始する。Calendar権限をsign-inと同時に要求する現UXを維持するか、in-contextな接続操作へ分離するかは引き続き利用者判断とする。

`calendar.app.created`で必要な全methodが公式上許可されるため、旧実装の広い`calendar`をproductionで維持する理由は現在の実装から見つからない。限定scopeがstaging実試験で成立しなかった場合だけ、失敗method、Google API応答分類、代替scopeの比較を新しい監査記録に残して再判断する。

## 利用規約・Privacyの不足

### 現在実装済み

- ホームから`/terms`と`/privacy`へ認証なしで移動できる。
- Termsはサービス概要、利用条件、禁止事項、外部サービスとの関係、停止、免責、account削除、変更を説明する。
- Privacyは取得情報、Google識別情報、暗号化refresh token、YouTube channel、専用Calendar、利用目的、安全管理、第三者提供、account削除を説明する。
- ホームはサービス名と主要機能をログイン前に説明するため、構造上は「ログインだけのページ」ではない。

### production公開前の不足

| 不足             | 現状                        | 完了に必要な内容                                                                                                   |
| ---------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 文書の正式性     | 共通warningがデモ文面と明示 | warningを除去し、承認済み版・発効日・最終更新日を表示                                                              |
| 運営主体         | 記載なし                    | サービス提供者/事業者名と、適用法令上必要な表示を確定                                                              |
| 問い合わせ       | 「本番公開前に記載」        | 利用者とGoogle review teamが到達でき、継続監視する連絡先                                                           |
| 保存期間         | 「一般公開前に正式化」      | refresh token、User、subscription、schedule/mapping、運用log、削除墓石、backupごとの期間と削除時期                 |
| Google user data | 概要のみ                    | access / use / storage / sharingをデータ種別と目的ごとに明記                                                       |
| Limited Use      | 準拠を将来確認すると記載    | Google API Services User Data Policyへの準拠を現在形で表明し、Limited Useへの明示的な準拠文と公式policy linkを掲載 |
| 委託・第三者     | Google・YouTubeだけを概括   | Supabase、AWS、Google/YouTube等の役割、委託/第三者提供の区別、越境取扱いを実態に合わせる                           |
| 人による閲覧等   | 記載なし                    | support/security例外、販売、広告、AI trainingへの利用有無を実運用に合わせて明示                                    |
| 利用者の権利     | account削除だけ             | 連携解除、削除、問い合わせ、適用法令上の開示/訂正等の請求方法と処理期間                                            |
| 削除の例外       | 全削除の概略のみ            | retry中、法令保持、security tombstone、backup消去までの扱いを過大表示なく明記                                      |
| 規約条件         | 招待制・開発中のまま        | productionの対象者、利用資格、提供地域、料金、停止/終了、責任、準拠法・管轄、通知方法を利用者判断で確定            |
| policy変更       | 通知方法が未定              | 重要変更の通知、発効日、必要時の再同意方法を決定                                                                   |

法的適合性は対象地域、運営主体、事業形態で変わるため、この監査は法律意見の代替ではない。最終文面は事実関係を決定した上で専門家確認を受ける。

## OAuth同意画面・公開審査の不足

### コード修正可能

- ~~Calendar scopeを共有定数化し、`calendar.app.created`へ縮小する。~~ 実装済み。
- ~~実付与scopeを確認し、部分拒否と旧grant混入を検出し、未使用`providerAccessToken`と固定scope保存を整理する。~~ 実装済み。
- Calendar権限を要求する直前に、専用Calendarの作成、event同期、暗号化refresh tokenによるbackground同期を簡潔に説明し、Privacyへリンクする。現在の「ログインすると同意したものとみなす」だけに依存しない。
- 現在のGoogleログインボタンはMUIの単色Google iconをアプリのprimary色背景に置く独自実装である。Googleの承認済みassetまたは現行branding guidelineどおりの標準色G、背景、font、padding、文言へ変更し、visual regressionで固定する。
- productionホームから「招待制プレビュー」などstaging限定表示を除き、アプリ機能とGoogle user dataを必要とする理由を正確に説明する。
- Terms/Privacyを正式版へ差し替え、placeholder/demo文字列をproduction build testで拒否する。
- policy version/effective dateを単一sourceから表示し、利用者判断で必要になった場合は同意versionを記録する。

### ユーザー判断必要

- productionの運営主体、公開domain、対象地域、対象年齢/利用資格、招待制か一般公開か、料金、準拠法・管轄を決める。
- support emailとPrivacy問い合わせ窓口、監視責任者を決める。
- データ種別ごとの保存期間、backup/log/tombstoneの保持、削除SLA、人によるsupport access、委託先、越境移転、広告・販売・AI trainingの有無を決める。
- Calendar権限をsign-inと同時に要求するか、Calendar接続時のin-context authorizationへ分離するかを決める。
- production専用Google Cloud/Supabase project、app name、logo、公開homepage/Terms/Privacy URLを決める。
- 正式なTerms/Privacyを専門家確認し、公開版を承認する。
- Supabase production projectでGoogle provider client、Site URL、redirect allowlistをproduction専用値へ設定する工程を別途承認する。

### Google Console操作必要

- stagingとは別のproduction Google Cloud projectとWeb OAuth clientを作成し、Calendar APIを有効化する。
- AudienceをExternalとして決定し、production公開前にPublishing statusをProductionへ変更する。
- Brandingへ正確なapp name、承認済みlogo、継続監視するuser support email、developer contactを設定する。
- production homepage、Terms、Privacy URLとAuthorized domainを設定し、project owner/editorと同じ主体でSearch ConsoleのDomain property所有権を確認する。
- production WebのJavaScript originと、production Supabase projectが指定する`/auth/v1/callback`だけをauthorized redirect URIへ登録する。アプリ側`/auth/callback`はSupabaseのSite URL/redirect allowlistへ登録する値であり、Google clientのredirect URIと混同しない。
- Data AccessへSupabaseが必要とするidentity scopeと決定済みのCalendar scopeだけを登録し、Consoleが表示するnon-sensitive / sensitive / restricted分類を記録する。
- consent screenの表示scopeと実リクエストを一致させ、不要なclient、origin、redirect、scopeをproduction projectから除く。
- app name/logo/domain/URLのbrand verificationと、scope分類に応じたdata access verificationを申請する。必要な場合は英語表示の完全なconsent screen、OAuth end-to-end、scopeを使う各機能を示すdemo videoとscope justificationを提出する。
- Googleからの照会に応答し、production公開前に必要なverification statusが承認済みである証跡をrelease記録へ残す。

Google Cloud / Supabase Dashboardの現在値はrepositoryから確認できない。stagingでOAuth受入済みであることを、production設定済み・審査済みの根拠にはしない。

## High 2完了条件チェックリスト

### A. 利用者判断と正式文面

- [ ] production domain、運営主体、公開対象、support/contact、適用地域、料金、準拠法・管轄が決定済み。
- [ ] retention matrixがtoken、アプリDB、log、backup、tombstoneを含み、削除SLAと例外を定義済み。
- [ ] 委託先、第三者提供、越境、人による閲覧、広告・販売・AI trainingの実態が確認済み。
- [ ] Terms/Privacyが実態と一致し、Limited Useを含むGoogle policyと対象法令について専門家確認済み。
- [ ] 発効日、version、重要変更の通知/再同意方針が承認済み。

### B. scope・アプリ修正

- [x] Calendar用scopeが`calendar.app.created`へ統一され、Web request、API保存、test、文書に別値がない。
- [x] 実付与scopeの不足・旧grant混入を検出でき、DBのscope記録が検証済みの意味を持つ。
- [ ] Calendar permissionをin-contextで説明し、拒否時はCalendar機能を呼ばず安全に再案内する。
- [ ] Googleログインボタンが現行branding guidelineに準拠する。
- [ ] productionホーム、Terms、Privacyからdemo、placeholder、staging限定表示が消え、認証なしで2xxになる。
- [ ] production build/testが法務placeholder、広いCalendar scope、公開URL不整合をfail-fastする。

### C. staging限定scope受入

- [ ] 過去grantのない利用者、または明示revoke済み利用者で、同意画面が限定scopeだけを示す。
- [ ] 新規onboarding、refresh、専用calendar get/reuse/create/deleteが成功する。
- [ ] event get/insert/patch/delete、決定的ID、404/410/取消復旧が成功し、重複を作らない。
- [ ] subscription削除、account削除、reauthが限定scopeで成功する。
- [ ] access tokenの実付与scopeとDB記録を匿名化して照合し、広い`calendar` grantが残っていない。

手動受入は次の順序に固定し、旧grantを持つ既存利用者での単なる成功を証跡にしない。

1. 別途承認された工程でGoogle Cloud/Supabase Data Accessをidentity 3種と`calendar.app.created`だけへ合わせ、対象commitをdeployする。
2. 当該Google projectを一度も許可していない専用テスト利用者を優先する。既存利用者を使う場合は、Google Accountの第三者アクセス設定から当該appのgrantを明示的にrevokeする。DBの`scopes`だけを書き換えない。
3. `prompt=consent`の同意画面で、全Calendarへの権限ではなくアプリ作成Calendarへの限定権限だけが表示されることを確認する。画面に旧Calendar権限が残れば中止する。
4. callback後、APIがonboardingを成功させたこと、`reauthRequired=false`、暗号化credentialあり、保存scopeがidentity 3種 + app-createdだけであることを、token・email・Calendar IDを表示せず確認する。
5. 新規calendar create、保存済みcalendar get/reuse、event get/insert/patch/delete、404/410/cancelled復旧、subscription削除、account削除、refreshを実行し、重複eventとCalendar APIエラーがないことを確認する。
6. 負の試験では、旧grantを含むtokenまたは必須scope不足を管理されたテスト条件で与え、onboarding未完了、credential未更新、`reauthRequired=true`、`setup=reauth`を確認する。実grantを偽装するDB更新は使わない。

### D. production外部設定・審査

- [ ] production専用Google Cloud/Supabase projectとcredentialがstagingから分離済み。
- [ ] homepage/Terms/Privacy/Authorized domain/Search Console所有権、support/developer contact、app name/logoが相互一致する。
- [ ] Google origin、Supabase callback、Supabase Site URL/app callbackがproduction URL matrixどおりである。
- [ ] production Consoleへ必要scopeだけが登録され、分類と必要なverification種別が記録済み。
- [ ] Publishing statusとbrand/data-access verificationが一般公開に必要な状態へ到達済み。
- [ ] scope justificationとdemo videoがproductionの画面、scope、機能と完全に一致する。

### E. 公開直前証跡

- [ ] productionのホーム、Terms、Privacyが公開URLで2xx、同一verified domain、内容一致、placeholderなし。
- [ ] controlled production OAuthで同意、callback、暗号化保存、Calendar CRUD、削除を受入済み。
- [ ] token、authorization code、email、Calendar IDがWeb/API/platform logへ出ていない。
- [ ] checklist各項目へ担当者、確認日、証跡URL/commitを付け、release approverがHigh 2をclosedにした。

## 推奨する着手順

scope最小化コードは完了した。次は、**別途承認の上でGoogle Cloud/Supabase Data Accessとstaging deployを限定scopeへ合わせ、旧grantを排除した手動受入を実施する。** 受入成功後、in-context説明とGoogle branding button、利用者判断に基づく正式Terms/Privacy、production Console設定・審査の順に進む。

## 公式根拠

- [Google Calendar API scopes](https://developers.google.com/workspace/calendar/api/auth)
- [Google OAuth 2.0 policies](https://developers.google.com/identity/protocols/oauth2/policies)
- [Google OAuth best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices)
- [Google OAuth verification requirements](https://support.google.com/cloud/answer/13464321?hl=en)
- [Google OAuth app submission](https://support.google.com/cloud/answer/13461325?hl=en)
- [Google OAuth branding settings](https://support.google.com/cloud/answer/15549049?hl=en)
- [Sign in with Google branding guidelines](https://developers.google.com/identity/branding-guidelines)
- [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)
- [Supabase Google login](https://supabase.com/docs/guides/auth/social-login/auth-google)
