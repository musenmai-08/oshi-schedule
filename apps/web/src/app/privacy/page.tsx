import type { Metadata } from 'next';
import { LegalDocument } from '@/components/legal-document';

export const metadata: Metadata = { title: 'プライバシーポリシー | 推しスケジュール' };

const sections = [
  {
    title: '1. 取得する情報',
    content:
      '本サービスは、Googleアカウントの識別子とメールアドレス、Google OAuthトークン、利用者が登録したYouTubeチャンネル、配信予定と同期状態、必要最小限の操作・障害情報を取得します。',
  },
  {
    title: '2. Googleアカウント情報',
    content:
      '認証、招待対象の確認、利用者の識別のために、Googleから提供される識別子とメールアドレスを利用します。',
  },
  {
    title: '3. Google OAuthトークン',
    content:
      '同期をバックグラウンドで継続するため、Googleのrefresh tokenをサーバー側で暗号化して保存します。OAuthトークンをブラウザーへ公開したり、同期以外の目的で利用したりしません。',
  },
  {
    title: '4. 登録したYouTubeチャンネル',
    content:
      '入力されたハンドル、チャンネルID、名称、サムネイルと、取得した配信予定を保存します。',
  },
  {
    title: '5. Googleカレンダーへの書き込み',
    content:
      '専用カレンダー「推しスケジュール」の作成と、配信予定の作成・更新・削除のためにGoogle Calendar APIを利用します。利用者の既存カレンダーを読み取って分析することを目的としません。',
  },
  {
    title: '6. 利用目的',
    content:
      '認証、チャンネル登録、配信予定の取得とCalendar同期、再認証の案内、障害対応、安全性確保のために取得情報を利用します。',
  },
  {
    title: '7. 保存と安全管理',
    content:
      'トークンの暗号化、アクセス制御、秘密情報のログ除外など、情報の性質に応じた安全管理措置を講じます。保存期間と運用手順は一般公開前に正式化します。',
  },
  {
    title: '8. 第三者提供',
    content:
      '法令に基づく場合を除き、利用者の同意なく個人情報を第三者へ提供しません。機能提供のためGoogle・YouTubeのAPIへ必要な情報を送信します。',
  },
  {
    title: '9. Google API Services User Data Policy',
    content:
      '一般公開前にGoogle API Services User Data Policy（Limited Use要件を含む）への準拠状況を確認し、必要な表示と運用手順を整備します。',
  },
  {
    title: '10. アカウント削除時のデータ削除',
    content:
      'アカウント削除時は、専用カレンダー、保存したOAuth認証情報、チャンネル登録と利用者別同期データ、認証ユーザーを再実行可能な手順で削除します。',
  },
  {
    title: '11. お問い合わせ',
    content: 'お問い合わせ先：本番公開前に記載します。',
  },
];

export default function PrivacyPage() {
  return <LegalDocument title="プライバシーポリシー" sections={sections} />;
}
