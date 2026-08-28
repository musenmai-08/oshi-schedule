import { describe, expect, it } from 'vitest';
import { GOOGLE_CALENDAR_SCOPE, GOOGLE_OAUTH_REQUEST_SCOPES } from '@oshi-schedule/shared';
import { googleOAuthOptions } from './google-oauth';

describe('Google OAuth options', () => {
  it('uses the callback, offline access, consent prompt and Calendar scope', () => {
    expect(googleOAuthOptions('https://app.example')).toEqual({
      redirectTo: 'https://app.example/auth/callback',
      scopes: GOOGLE_OAUTH_REQUEST_SCOPES.join(' '),
      queryParams: {
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'false',
      },
    });
    expect(googleOAuthOptions('https://app.example').scopes).toContain(GOOGLE_CALENDAR_SCOPE);
    expect(googleOAuthOptions('https://app.example').queryParams.include_granted_scopes).not.toBe(
      'true',
    );
  });
});
