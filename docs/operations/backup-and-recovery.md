# バックアップ・障害復旧

## 暫定目標（運用方針）

| 環境       | RPO    | RTO        | 自動backup           | 補足                                   |
| ---------- | ------ | ---------- | -------------------- | -------------------------------------- |
| staging    | 24時間 | 次の営業日 | 1日 retention        | migration検証前は必要に応じsnapshot    |
| production | 5分    | 4時間      | 7日 retention + PITR | schema変更deploy前にon-demand snapshot |

RPO/RTOは小規模betaの暫定目標でありSLAではない。一般公開、売上発生、または復旧演習で4時間を超えた場合はretention、Multi-AZ、automationを見直す。

### IaCで確定している実設定

上表のproduction「7日 retention + PITR」は運用上の目標であり、現行CDKが自動的に強制する値ではない。CDKは`rdsBackupRetentionDays` contextを受け取り、未指定時は1日、`deleteAutomatedBackups=false`、productionではdeletion protectionを有効にする。productionの最終context値、PITRの有効化、手動snapshotの保持期限は、production構築前に明示的に決定・検証する。手動snapshotの自動削除期限はCDKで設定していない。

## RDS保護

- production RDSはencryption at rest、deletion protection、`rdsBackupRetentionDays`で指定した自動backup、`deleteAutomatedBackups=false`を使用する。7日/PITRはproduction contextとAWS設定で明示確認するまで目標値であり、CDK既定値ではない。backup windowとworker実行時間をずらす。
- stagingはCDK既定でdeletion protectionを有効にし、自動backup 1日を維持する。初期構築時に一時的に解除する場合もcontext reviewを必須にし、通常は長期snapshotを持たない。破壊的test/migration前だけsnapshotを取得し、30日以内に削除する。
- productionのschema migration前にsnapshotを取り、migration ID、image digest、取得時刻をdeploy recordへ残す。
- automated backup/snapshotの削除、retention短縮、deletion protection解除はmanual approval対象とする。
- 四半期ごとにproduction backupから隔離した新RDSへrestore rehearsalを行う。元RDSを上書きしない。
- CDK stackを削除してもRDS snapshot、RDS managed secret、ECR imageがretain/snapshot policyにより残る。stack削除をdata完全削除とみなさず、残存resourceと費用を手動確認する。

production stackは常にRDS`Retain`とdeletion protectionを使う。`cdk destroy`は日常の停止手段ではなく、productionでは別reviewとbackup復元確認なしに実行しない。

## production復元手順

1. incident時刻と最終正常時刻を確定し、worker scheduleをdisableしてwriteを止める。必要ならAPIをmaintenance modeへする。
2. RDS event、backup、transaction logの利用可能時点を確認する。
3. 最終正常時刻へPITRし、**新しい**RDS instanceを作る。元instanceを削除・上書きしない。
4. isolated security groupからschema/migration status、主要table件数、外部キー、重複、credential暗号形式を検証する。token/個人情報は表示しない。
5. 必要な未適用migrationを単一taskで適用し、read-only smokeを実施する。
6. ECSが参照するDB secret/endpointを新instanceへ更新して新task revisionをdeployする。API readiness確認後にtrafficを切り替える。
7. workerを一度だけcontrolled runし、Calendar差分とquotaを確認してscheduleを再開する。
8. RPO内の欠損、外部Calendarとの不整合、影響userを評価する。元RDSはincident解決までread-onlyで保持する。

## 障害シナリオ

| シナリオ                    | 復旧                                                                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 誤migration/DB data破損     | deploy停止、forward-fix可能性を評価。不可なら新RDSへPITRし切替                                                                                                              |
| RDS instance/AZ障害         | Single-AZ betaではAWS recoveryを待つかsnapshot/PITRで新instance。RTO違反が続けばMulti-AZ化                                                                                  |
| worker重複/途中終了         | lease expiry後に再実行。fencingで旧ownerのwriteを拒否し、SyncRun結果を確認                                                                                                  |
| Google credential失効       | `reauthRequired`を立てuserへ再同意を案内。refresh tokenをbackupからチャット等へ取り出さない                                                                                 |
| 専用Calendar/event削除      | Connectionを検証し、Calendarが存在すればDBのBroadcast/同期状態から次回同期でmanaged eventを再作成。Calendar自体がない場合は再onboarding/reconnectで新Calendarを作り、全同期 |
| Supabase障害/project誤設定  | projectを環境別に確認。Supabase backup/recovery手順に従い、RDS Userとのidentity mappingを検証                                                                               |
| `TOKEN_ENCRYPTION_KEYS`紛失 | DB内refresh tokenは復号不能。Calendar dataは残るが全userにGoogle再同意が必要。keyを推測・再生成して復号しようとしない                                                       |
| Secret漏えい                | 漏れたGoogle/Supabase/YouTube/DB credentialをprovider側でrevoke/rotateし、新ECS revisionをdeploy。log/artifact/cacheを調査                                                  |

Calendar eventはYouTube由来のtitle/time/type/URLとDB上のmappingから再構築できる。ただしGoogle Calendarはbackupではなく外部派生先である。Google側だけで変更された情報や削除済み専用Calendar IDはRDS backupから完全復元できないため、read-only検証後のfull syncが必要になる。

## 暗号鍵のbackupとrotation

`TOKEN_ENCRYPTION_KEYS`はGoogle refresh tokenを復号できる最重要secretである。

1. 環境別の専用Secrets Manager secretでversion管理する。
2. production keyの暗号化offline recovery copyを、AWSとは別の個人用password managerまたは暗号化removable backupへ保存する。アクセス者と復元手順を記録し、平文fileを置かない。
3. 四半期ごと、漏えい疑い時、または管理者変更時にrotateする。新しい32-byte random keyを新IDで先頭追加し、新規writeを切り替える。
4. background taskで既存ciphertextを新keyへ再暗号化し、件数とkey IDだけを検証する。
5. 全行の移行、backup、rollback windowを確認後に旧keyを削除する。先に旧keyを削除しない。
6. 半年ごとにoffline copyからsandboxでrecovery手順を検証し、実tokenのGoogle API利用は行わない。

DB backupと暗号鍵backupの両方がなければcredentialを復旧できない。両者を同じ場所・同じcredentialだけに依存させない。

## Secret rotation一覧

| Secret                           | 通常rotation                     | 緊急時                                                       |
| -------------------------------- | -------------------------------- | ------------------------------------------------------------ |
| DB credential                    | 90日またはRDS managed rotation   | 新credential→task deploy→旧credential失効                    |
| Google client secret             | 年1回、provider方針変更時        | Google Cloudでrotateしstaging検証後production                |
| Supabase service role/secret key | provider機能とincident方針に従う | 新key deploy後に旧key revoke                                 |
| YouTube API key                  | 漏えい/制限変更時                | key restriction確認、新keyへ切替、旧key revoke               |
| token encryption key             | 四半期またはincident             | 上記のmulti-key再暗号化。緊急でも旧keyを復号完了前に消さない |

## Supabaseと設定の保全

Supabase AuthはRDSとは別の復旧境界である。productionはbackupが提供されるplanを使い、Google provider、Site URL、Redirect URL、email/provider policyをInfrastructure/operations checklistに記録する。API keyやclient secretの実値を文書へ保存しない。

## 関連文書

- [環境戦略](environment-strategy.md)
- [デプロイとrollback](deployment.md)
- [監視とbackup alarm](monitoring.md)
