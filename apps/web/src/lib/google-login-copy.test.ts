import { describe, expect, it } from 'vitest';
import {
  GOOGLE_CALENDAR_PERMISSION_NOTICE,
  GOOGLE_CALENDAR_PERMISSION_TITLE,
  GOOGLE_LOGIN_LABEL,
} from './google-login-copy';

describe('Google login permission copy', () => {
  it('explains the narrow Calendar purpose before OAuth starts', () => {
    expect(GOOGLE_CALENDAR_PERMISSION_TITLE).toContain('Google Calendar');
    expect(GOOGLE_CALENDAR_PERMISSION_NOTICE).toContain('専用');
    expect(GOOGLE_CALENDAR_PERMISSION_NOTICE).toContain('作成・更新・削除');
    expect(GOOGLE_CALENDAR_PERMISSION_NOTICE).toContain(
      '既存のカレンダーを読み取る権限ではありません',
    );
  });

  it('uses the localized Google sign-in label', () => {
    expect(GOOGLE_LOGIN_LABEL).toBe('Google でログイン');
  });
});
