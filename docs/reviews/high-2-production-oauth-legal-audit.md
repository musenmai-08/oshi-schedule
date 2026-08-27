# High 2 production OAuth・法務表示 詳細監査

- 実施日: 2026-08-27
- 対象: Google OAuth / Calendar scope、Google Calendar Gateway、公開ホーム、利用規約、プライバシーポリシー、production公開審査準備
- 制約: コード、AWS、Google Cloud、Supabase、DB、OAuth grantは変更していない。AWS APIも呼び出していない。

## 判定

**High 2は未解消であり、production一般公開のblockerである。**

Calendar APIの実装は、アプリ自身が作成するsecondary calendarとそのeventだけを操作する。このため、現行の全Calendarへ作用できる`https://www.googleapis.com/auth/calendar`ではなく、`https://www.googleapis.com/auth/calendar.app.created`をCalendar用の最小scope候補とする根拠は十分である。ただし、scope変更、既存grantの縮小、実付与scopeの確認、stagingでの全操作受入はまだ行っていない。

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

| 層                           | 現在の状態                                                                       | 監査結果                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Web OAuth request            | `https://www.googleapis.com/auth/calendar`                                       | `google-oauth.ts`が明示する唯一のCalendar scope                               |
| Google identity              | Supabase Google Authが`openid`、`userinfo.email`、`userinfo.profile`を必要とする | repositoryはGoogle Cloud Data Access設定を管理しないため、実Console値は未確認 |
| offline consent              | `access_type=offline`、`prompt=consent`                                          | background同期用refresh token取得に必要                                       |
| incremental grant            | `include_granted_scopes=true`                                                    | 過去に同じGoogle projectへ許可した広いscopeも新tokenへ結合され得る            |
| callback                     | `provider_refresh_token`と`provider_token`をonboarding APIへ送信                 | refresh tokenは暗号化保存。provider access tokenはAPI入力後に利用されない     |
| DB `GoogleCredential.scopes` | `calendar`を固定文字列で保存                                                     | 実際にGoogleが付与したscopeの検査結果ではない                                 |
| 設計文書                     | `authentication.md`と`security-policy.md`も現行`calendar`を記載                  | コードとは一致しているがproduction最小権限ではない                            |

Googleは、requestしたscopeとaccess tokenへ実際に付与されたscopeが一致しない場合を考慮し、付与scopeを確認して不足機能を無効化するよう案内している。現実装はCalendar権限の一部拒否や過去grantの混入を検査せず、DBへrequest側の固定値を記録するため、scope縮小時にこのまま「最小scopeが実際に付与された」とは証明できない。

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

公式scope一覧では、現行`calendar`は利用者がアクセス可能な全Calendarの参照・編集・共有・完全削除を許可する。一方、`calendar.app.created`はsecondary calendarの作成と、そのアプリ作成calendar内のevent参照・作成・変更・削除に限定される。Gatewayとの照合結果から、Calendar用の最小候補は次である。

```text
https://www.googleapis.com/auth/calendar.app.created
```

Google sign-inに必要なidentity scopeはCalendar scopeとは別で、production Google Cloud projectではSupabaseの要件に従い`openid`、`userinfo.email`、`userinfo.profile`も正確に登録する。アプリはemail allowlistと主体識別を利用している。Google Cloud Consoleが表示するscope分類と必要な審査種別は、その時点のproduction projectで確認し、文書から推測しない。

## scope変更の実装案（今回は未実施）

1. WebとAPIが同じ値を使う共有定数を作り、`calendar.app.created`へ変更する。OAuth request、DBの`scopes`、テスト、認証設計を同時に更新する。
2. `provider_token`から実付与scopeを安全に確認する経路を設計する。少なくとも必要scopeの不足をonboarding失敗または再認証へ分類し、DBの`scopes`を未検証の固定値として保存しない。tokenやtoken付きURLはログへ出さない。
3. productionは新しいGoogle Cloud project/clientを使用し、過去のstaging grantを持ち込まない。production初回consentは最初から限定scopeだけにする。
4. staging既存利用者では`include_granted_scopes=true`により旧`calendar` grantが結合され得る。限定scopeの検証には、当該projectを一度も許可していないテスト利用者を使うか、既存grantを明示的にrevokeしてから再同意する。DB文字列だけを書き換えて移行済み扱いにしない。
5. Calendar権限はサービスの中核機能だが、現在はsign-inと同時に要求する。production UXとして、ログイン前に権限の目的を明示して一括同意を求めるか、identity login後に「Googleカレンダーを接続」の利用者操作でincremental authorizationするかを決定する。後者がGoogleのin-context authorization推奨へより明確に適合する。
6. stagingで新規calendar作成、既存calendar再利用、event get/insert/patch/delete、404/410/取消event復旧、subscription削除、account削除でのcalendar削除、refresh、reauthを受入し、Google同意画面と実付与scopeも記録する。

`calendar.app.created`で必要な全methodが公式上許可されるため、現行の広い`calendar`をproductionで維持する理由は現在の実装から見つからない。限定scopeがstaging実試験で成立しなかった場合だけ、失敗method、Google API応答分類、代替scopeの比較を新しい監査記録に残して再判断する。

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

- Calendar scopeを共有定数化し、`calendar.app.created`へ縮小する。
- 実付与scopeを確認し、部分拒否と旧grant混入を検出する。現在の未使用`providerAccessToken`と固定`GoogleCredential.scopes`の意味も整理する。
- Calendar権限を要求する直前に、専用Calendarの作成、event同期、暗号化refresh tokenによるbackground同期を簡潔に説明し、Privacyへリンクする。現在の「ログインすると同意したものとみなす」だけに依存しない。
- 現在のGoogleログインボタンはMUIの単色Google iconをアプリのprimary色背景に置く独自実装である。Googleの承認済みassetまたは現行branding guidelineどおりの標準色G、背景、font、padding、文言へ変更し、visual regressionで固定する。
- productionホームから「招待制プレビュー」などstaging限定表示を除き、アプリ機能とGoogle user dataを必要とする理由を正確に説明する。
- Terms/Privacyを正式版へ差し替え、placeholder/demo文字列をproduction build testで拒否する。
- policy version/effective dateを単一sourceから表示し、利用者判断で必要になった場合は同意versionを記録する。

### ユーザー判断必要

- productionの運営主体、公開domain、対象地域、対象年齢/利用資格、招待制か一般公開か、料金、準拠法・管轄を決める。
- support emailとPrivacy問い合わせ窓口、監視責任者を決める。
- データ種別ごとの保存期間、backup/log/tombstoneの保持、削除SLA、人によるsupport access、委託先、越境移転、広告・販売・AI trainingの有無を決める。
- `calendar.app.created`採用と、sign-in同時同意かCalendar接続時のincremental authorizationかを決める。
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

- [ ] Calendar用scopeが`calendar.app.created`へ統一され、Web request、API保存、test、文書に別値がない。
- [ ] 実付与scopeの不足・旧grant混入を検出でき、DBのscope記録が検証済みの意味を持つ。
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

最初に、**`calendar.app.created`をproductionのCalendar scopeとして採用し、stagingで新規grantによる全Gateway操作を検証する方針を承認する。** scopeはPrivacyの説明、Google Console Data Access、scope justification、demo videoの全てを決めるため、先に固定しないと法務文面と審査資料を確定できない。

その承認後は、scope/付与確認/branding buttonのコード修正、staging限定scope受入、利用者判断に基づく正式Terms/Privacy、production Console設定・審査の順に進む。

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
