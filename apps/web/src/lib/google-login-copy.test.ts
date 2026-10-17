import { describe, expect, it } from 'vitest';
import {
  GOOGLE_CALENDAR_PERMISSION_NOTICE,
  GOOGLE_CALENDAR_PERMISSION_TITLE,
  GOOGLE_LOGIN_LABEL,
} from './google-login-copy';

describe('Google login permission copy', () => {
  it('explains the narrow Calendar purpose before OAuth starts', () => {
    expect(GOOGLE_CALENDAR_PERMISSION_TITLE).toContain('Google Calendar');
    expect(GOOGLE_CALENDAR_PERMISSION_NOTICE).toContain('dedicated');
    expect(GOOGLE_CALENDAR_PERMISSION_NOTICE).toContain('create, update, and delete');
    expect(GOOGLE_CALENDAR_PERMISSION_NOTICE).toContain('do not read your existing calendars');
  });

  it('uses the localized Google sign-in label', () => {
    expect(GOOGLE_LOGIN_LABEL).toBe('Sign in with Google');
  });
});
