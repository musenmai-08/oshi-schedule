import { describe, expect, it } from 'vitest';
import {
  LEGAL_CONTACT_EMAIL,
  LEGAL_EFFECTIVE_DATE,
  LEGAL_OPERATOR,
  privacySections,
  termsSections,
} from './legal-content';

const contentOf = (sections: ReadonlyArray<{ content: string }>) =>
  sections.map((section) => section.content).join('\n');

describe('formal legal content', () => {
  it('identifies the operator, contact address and effective date', () => {
    expect(LEGAL_OPERATOR).toBe('推しスケジュール運営者');
    expect(LEGAL_CONTACT_EMAIL).toBe('oshi.schedule@gmail.com');
    expect(LEGAL_EFFECTIVE_DATE).toBe('2026年8月30日');
    expect(contentOf(termsSections)).toContain(LEGAL_CONTACT_EMAIL);
    expect(contentOf(privacySections)).toContain(LEGAL_CONTACT_EMAIL);
  });

  it('states Google data limits and does not retain demo copy', () => {
    const privacy = contentOf(privacySections);
    expect(privacy).toContain('作成・更新・削除');
    expect(privacy).toContain('既存のカレンダー一覧');
    expect(privacy).toContain('広告のために利用・共有せず');
    expect(privacy).toContain('販売せず');
    expect(privacy).toContain('AIモデルの学習にも利用しません');
    expect(privacy).toContain('Limited Use');
    expect(privacySections.find((section) => section.link)?.link?.href).toBe(
      'https://developers.google.com/terms/api-services-user-data-policy',
    );

    for (const content of [contentOf(termsSections), privacy]) {
      expect(content).not.toMatch(/開発・動作確認用|本番公開前に記載|未定/);
    }
  });

  it('documents the implemented retention and deletion behavior without inventing a backup period', () => {
    const privacy = contentOf(privacySections);
    expect(privacy).toContain('90日');
    expect(privacy).toContain('完了から30日');
    expect(privacy).toContain('7日間保持');
    expect(privacy).toContain('手動snapshotは原則30日以内に削除');
    expect(privacy).toContain('IaC上30日保持');
    expect(privacy).toContain('法令上保持が必要な情報');
  });

  it('states the approved Japan-only, free-service, and jurisdiction terms', () => {
    const terms = contentOf(termsSections);
    const privacy = contentOf(privacySections);
    expect(terms).toContain('日本国内の利用者向け');
    expect(terms).toContain('現時点では無料');
    expect(terms).toContain('将来有料機能を追加する場合があります');
    expect(terms).toContain('料金、支払条件');
    expect(terms).toContain('日本法');
    expect(terms).toContain('東京地方裁判所');
    expect(terms).toContain('13歳未満の方は利用できません');
    expect(privacy).toContain('日本国内の利用者向け');
  });
});
