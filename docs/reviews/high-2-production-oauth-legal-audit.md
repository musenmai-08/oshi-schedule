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

| 不足             | 現状                                                                                          | 完了に必要な内容                                      |
| ---------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 文書の正式性     | 2026-08-30にデモwarningを除去し、制定日・最終更新日を表示                                     | 法律・運営上の最終承認とproduction公開URLでの表示確認 |
| 運営主体         | 推しスケジュール運営者を記載                                                                  | 適用法令上必要な事業者表示の専門家確認                |
| 問い合わせ       | `oshi.schedule@gmail.com`を記載                                                               | 継続監視体制の確認                                    |
| 保存期間         | アクティブなアカウント期間、SyncRun通常90日、productionログ30日、削除墓石の自動削除なしを記載 | production backup保持期間、墓石の削除SLAを確定        |
| Google user data | access / use / storage / sharingをデータ種別と目的ごとに記載                                  | production運用との最終照合                            |
| Limited Use      | Google API Services User Data Policy（Limited Useを含む）への準拠と公式policy linkを記載      | Google審査要件との最終確認                            |
| 委託・第三者     | Supabase、AWS、Google、YouTubeの役割と国外取扱いの可能性を記載                                | 各委託先・越境取扱いの法的確認                        |
| 人による閲覧等   | support/security等に必要な場合だけの運営者アクセス、広告・販売・AI学習への不使用を記載        | 実運用access review                                   |
| 利用者の権利     | 設定画面の削除申請とメールでの問い合わせを記載                                                | 適用法令上の処理期限・本人確認手順を確定              |
| 削除の例外       | 外部削除失敗時の再開記録、墓石、backupの非即時削除を記載                                      | 墓石・backupの期限を確定                              |
| 規約条件         | サービス内容、禁止事項、停止、免責、変更通知を記載                                            | 対象地域、料金、準拠法・管轄を利用者判断で確定        |
| policy変更       | 掲載時効力と重要変更の周知を記載                                                              | 再同意が必要となる変更基準を確定                      |

法的適合性は対象地域、運営主体、事業形態で変わるため、この監査は法律意見の代替ではない。最終文面は事実関係を決定した上で専門家確認を受ける。

## OAuth同意画面・公開審査の不足

### コード修正可能

- ~~Calendar scopeを共有定数化し、`calendar.app.created`へ縮小する。~~ 実装済み。
- ~~実付与scopeを確認し、部分拒否と旧grant混入を検出し、未使用`providerAccessToken`と固定scope保存を整理する。~~ 実装済み。
- ~~Calendar権限を要求する直前に、専用Calendarの作成、event同期、暗号化refresh tokenによるbackground同期を簡潔に説明し、Privacyへリンクする。現在の「ログインすると同意したものとみなす」だけに依存しない。~~ 2026-08-30にログイン前と再連携前へ、専用カレンダーと配信予定の作成・更新・削除だけに使う旨、および既存カレンダーを読み取らない旨を表示した。
- ~~現在のGoogleログインボタンはMUIの単色Google iconをアプリのprimary色背景に置く独自実装である。Googleの承認済みassetまたは現行branding guidelineどおりの標準色G、背景、font、padding、文言へ変更し、visual regressionで固定する。~~ 2026-08-30にGoogleの標準的な白背景・境界線・黒文字・Roboto系font・ローカライズ文言（`Google でログイン`）へ変更し、再連携ボタンにも同じブランドスタイルを適用した。
- productionホームから「招待制プレビュー」などstaging限定表示を除き、アプリ機能とGoogle user dataを必要とする理由を正確に説明する。
- ~~Terms/Privacyを正式版へ差し替え、placeholder/demo文字列をproduction build testで拒否する。~~ 2026-08-30に正式文面、運営者、問い合わせ先、制定日・最終更新日を単一sourceで表示する実装へ更新し、関連UI testでデモ・placeholder文言がないことを固定した。
- ~~policy version/effective dateを単一sourceから表示し、利用者判断で必要になった場合は同意versionを記録する。~~ 発効日を単一sourceで表示する実装は完了。利用規約の同意version記録は、必要性の利用者判断後に別途実装する。

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
- [x] Calendar permissionをin-contextで説明し、拒否時はCalendar機能を呼ばず安全に再案内する。
- [x] Googleログインボタンが現行branding guidelineに準拠する。
- [x] `/terms`と`/privacy`からdemo warning、placeholder、未定の問い合わせ先を除去し、運営者、連絡先、発効日、Google user data取扱いを記載する。
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

## 2026-08-30 Terms / Privacy正式化

`/terms`と`/privacy`を正式文面へ更新した。運営者を「推しスケジュール運営者」、問い合わせ先を`oshi.schedule@gmail.com`、制定日・最終更新日を2026年8月30日として表示する。Privacyは、Google識別子・メールアドレス・暗号化refresh token・実grant・専用Calendar ID・登録channel・配信予定・同期結果・削除記録と、短期access tokenを永続保存しないことを実装と照合して記載した。

実装済みの保持・削除は、アクティブなアカウント期間の利用者データ保持、通常workerによる完了SyncRunの90日後削除、production templateのログ30日保持、account削除でのCalendar削除試行・Google認可取り消し・アプリUser削除・Supabase Auth削除である。共有YouTube channel/broadcastは利用者との関連を外した後も残り得る。削除墓石は安全な再開のためSupabase subject、Calendar ID snapshot、状態・時刻・error codeを持つが、現行は自動削除期間がない。backupは通常データ削除と同時に消去されない。

このため、production backupの実保持期間、削除墓石の削除SLA、対象地域・料金・準拠法・管轄、適用法令上のアクセス請求処理、委託先/越境の法的確認および専門家承認は未解決のHigh 2 blockerとして残す。production URL、Google/Supabase外部設定、OAuth審査は変更していない。

## 推奨する着手順

scope最小化、限定scope受入、in-context説明、Google branding button、Terms/Privacyのアプリ実装は完了した。次は、**production backup・墓石保持の方針、対象地域等の利用者判断と専門家確認を完了し、その後にproduction URL、Google Cloud/Supabase外部設定・OAuth審査を進める。**

## 2026-08-30 Terms / Privacy技術事項の再確認

## 公式根拠

CDKとPrismaの実装を再確認し、公開文面へ反映した。RDS自動backupは`rdsBackupRetentionDays`で設定され、未指定時は1日、`deleteAutomatedBackups=false`、production deletion protection、非公開サブネット、暗号化を使用する。運用文書にあるproduction 7日/PITRは目標値であり、現行IaCはproduction専用値やPITRを強制しない。手動snapshotの自動削除期限も未設定である。production構築前に最終値を決める必要がある。

アカウント削除では、Userと利用者専用のCredential、CalendarConnection、subscription、mappingを削除し、共有YouTube channel/broadcastは残る。SyncRunは`requestedBy`をNULLにして残り、完了から90日を超えた次回定期メンテナンスで削除される。削除墓石（AccountDeletionRequest）は状態・時刻・error code・subject/calendar snapshotを保持し、自動purgeも完了SLAも実装されていない。API/Worker/HTTP API/RDSログはproduction 30日、staging 14日をIaCで設定する。RDS backupは通常データ削除と同時に消えず、設定retention経過後に失効するため、backup・log・SyncRun・墓石は同時削除ではない。

この再確認で確定できなかったのは、production contextの最終backup日数/PITR、手動snapshotと墓石の保持・削除SLA、対象地域・料金・準拠法・管轄、法令上の請求処理期限、委託先/越境の法的確認および専門家承認である。

- [Google Calendar API scopes](https://developers.google.com/workspace/calendar/api/auth)
- [Google OAuth 2.0 policies](https://developers.google.com/identity/protocols/oauth2/policies)
- [Google OAuth best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices)
- [Google OAuth verification requirements](https://support.google.com/cloud/answer/13464321?hl=en)
- [Google OAuth app submission](https://support.google.com/cloud/answer/13461325?hl=en)
- [Google OAuth branding settings](https://support.google.com/cloud/answer/15549049?hl=en)
- [Sign in with Google branding guidelines](https://developers.google.com/identity/branding-guidelines)
- [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)
- [Supabase Google login](https://supabase.com/docs/guides/auth/social-login/auth-google)
