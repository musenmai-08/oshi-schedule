import type { Metadata } from 'next';
import { LegalDocument } from '@/components/legal-document';

export const metadata: Metadata = { title: '利用規約 | 推しスケジュール' };

const sections = [
  {
    title: '1. 本サービスについて',
    content:
      '推しスケジュールは、登録したYouTubeチャンネルの配信予定を利用者専用のGoogleカレンダーへ同期する開発中のサービスです。',
  },
  {
    title: '2. 利用条件',
    content:
      '利用者は、自身が管理するGoogleアカウントでログインし、正当な目的の範囲で本サービスを利用するものとします。現在は招待された利用者だけが対象です。',
  },
  {
    title: '3. 禁止事項',
    content:
      '不正アクセス、過度な自動操作、他者のアカウントの利用、本サービスや外部サービスの運営を妨げる行為、法令または公序良俗に反する行為を禁止します。',
  },
  {
    title: '4. YouTube・Googleサービスとの関係',
    content:
      '本サービスはYouTubeおよびGoogleの公式サービスではなく、Google LLCによって提供、保証、承認されたものではありません。利用者は各外部サービスの規約にも従う必要があります。',
  },
  {
    title: '5. サービス内容の変更・停止',
    content:
      '保守、障害、外部APIの変更その他の事情により、予告なく内容を変更し、または提供を一時停止・終了する場合があります。',
  },
  {
    title: '6. 免責事項',
    content:
      '配信予定や同期結果の完全性、正確性、即時性を保証しません。外部サービスの仕様変更や障害により機能が利用できない場合があります。',
  },
  {
    title: '7. アカウント削除',
    content:
      '利用者は設定画面からアカウント削除を依頼できます。削除に伴い、専用カレンダー、登録チャンネル、同期情報、保存したGoogle認証情報を削除します。',
  },
  {
    title: '8. 規約変更',
    content:
      '必要に応じて本規約を変更する場合があります。重要な変更は、正式版で定める方法により通知します。',
  },
  {
    title: '9. お問い合わせ',
    content: 'お問い合わせ先：本番公開前に記載します。',
  },
];

export default function TermsPage() {
  return <LegalDocument title="利用規約" sections={sections} />;
}
