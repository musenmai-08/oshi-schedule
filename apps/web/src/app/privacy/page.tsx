import type { Metadata } from 'next';
import { LegalDocument } from '@/components/legal-document';
import { LEGAL_EFFECTIVE_DATE, privacySections } from '@/lib/legal-content';

export const metadata: Metadata = { title: 'プライバシーポリシー | 推しスケジュール' };

export default function PrivacyPage() {
  return (
    <LegalDocument
      title="プライバシーポリシー"
      effectiveDate={LEGAL_EFFECTIVE_DATE}
      sections={privacySections}
    />
  );
}
