import { describe, expect, it } from 'vitest';
import { buildSecurityHeaders } from './security-headers';

const asRecord = (headers: ReturnType<typeof buildSecurityHeaders>) =>
  Object.fromEntries(headers.map(({ key, value }) => [key.toLowerCase(), value]));

describe('Web security headers', () => {
  it('sets browser hardening headers without HSTS or development CSP locally', () => {
    const headers = asRecord(buildSecurityHeaders({ production: false }));
    expect(headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-frame-options': 'DENY',
    });
    expect(headers).not.toHaveProperty('strict-transport-security');
    expect(headers).not.toHaveProperty('content-security-policy');
  });

  it('limits production CSP to the configured API and Supabase origins', () => {
    const headers = asRecord(
      buildSecurityHeaders({
        production: true,
        apiUrl: 'https://api.example.com/v1',
        supabaseUrl: 'https://project.supabase.co',
      }),
    );
    const csp = headers['content-security-policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self' https://api.example.com https://project.supabase.co");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/(?:^|\s)\*(?:\s|;|$)/);
    expect(headers).not.toHaveProperty('strict-transport-security');
  });
});
