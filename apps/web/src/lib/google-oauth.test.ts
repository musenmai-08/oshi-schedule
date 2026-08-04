import { describe, expect, it } from 'vitest';
import { GOOGLE_CALENDAR_SCOPE, googleOAuthOptions } from './google-oauth';

describe('Google OAuth options', () => {
  it('uses the callback, offline access, consent prompt and Calendar scope', () => {
    expect(googleOAuthOptions('https://app.example')).toEqual({
      redirectTo: 'https://app.example/auth/callback',
      scopes: GOOGLE_CALENDAR_SCOPE,
      queryParams: {
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
      },
    });
  });
});
