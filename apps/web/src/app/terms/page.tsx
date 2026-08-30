import type { Metadata } from 'next';
import { LegalDocument } from '@/components/legal-document';
import { LEGAL_EFFECTIVE_DATE, termsSections } from '@/lib/legal-content';

export const metadata: Metadata = { title: '利用規約 | 推しスケジュール' };

export default function TermsPage() {
  return (
    <LegalDocument title="利用規約" effectiveDate={LEGAL_EFFECTIVE_DATE} sections={termsSections} />
  );
}
