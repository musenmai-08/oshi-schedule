import { describe, expect, it } from 'vitest';
import {
  channelHandleSchema,
  entityIdSchema,
  GOOGLE_CALENDAR_SCOPE,
  validateGoogleGrantedScopes,
} from './index.js';

describe('channelHandleSchema', () => {
  it('accepts a YouTube handle', () =>
    expect(channelHandleSchema.parse(' @oshi_test ')).toBe('@oshi_test'));
  it('rejects a URL', () => expect(() => channelHandleSchema.parse('youtube.com/@oshi')).toThrow());
});

describe('entityIdSchema', () => {
  it('accepts Prisma CUIDs and rejects UUIDs or malformed values', () => {
    expect(entityIdSchema.safeParse('cm0wz73bk0000qzrmn831i7rn').success).toBe(true);
    expect(entityIdSchema.safeParse('d6ba9e4d-e391-4290-93e7-6fe43dfff917').success).toBe(false);
    expect(entityIdSchema.safeParse('../invalid').success).toBe(false);
  });
});

describe('validateGoogleGrantedScopes', () => {
  const identityScopes =
    'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile';

  it('accepts and normalizes the least-privilege Calendar grant', () => {
    expect(
      validateGoogleGrantedScopes(`${GOOGLE_CALENDAR_SCOPE} ${identityScopes} openid`),
    ).toEqual({
      valid: true,
      scopes: [
        'https://www.googleapis.com/auth/calendar.app.created',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
        'openid',
      ],
      serialized:
        'https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile openid',
      missing: [],
      unexpectedCalendarScopes: [],
    });
  });

  it('accepts Google identity aliases but rejects a missing required scope', () => {
    const result = validateGoogleGrantedScopes(`${GOOGLE_CALENDAR_SCOPE} openid email profile`);
    expect(result.valid).toBe(true);
    expect(validateGoogleGrantedScopes('openid email profile').missing).toEqual([
      'calendar.app.created',
    ]);
  });

  it('rejects an old broad Calendar grant even when app-created is also present', () => {
    const result = validateGoogleGrantedScopes(
      `${identityScopes} ${GOOGLE_CALENDAR_SCOPE} https://www.googleapis.com/auth/calendar`,
    );
    expect(result.valid).toBe(false);
    expect(result.unexpectedCalendarScopes).toEqual(['https://www.googleapis.com/auth/calendar']);
  });
});
