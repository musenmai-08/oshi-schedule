import { describe, expect, it } from 'vitest';
import { resolveWebOrigin } from './server-web-origin';

describe('server Web origin', () => {
  it('uses the configured canonical staging origin', () => {
    expect(
      resolveWebOrigin({
        NODE_ENV: 'production',
        WEB_ORIGIN: 'https://staging.oshi-schedule.com',
      }),
    ).toBe('https://staging.oshi-schedule.com');
  });

  it('uses the local Web port only outside production', () => {
    expect(resolveWebOrigin({ NODE_ENV: 'development' })).toBe('http://localhost:3001');
    expect(() => resolveWebOrigin({ NODE_ENV: 'production' })).toThrow(/WEB_ORIGIN is required/);
  });

  it('rejects an unsafe or non-origin deployment value', () => {
    expect(() =>
      resolveWebOrigin({ NODE_ENV: 'production', WEB_ORIGIN: 'http://staging.example.com' }),
    ).toThrow(/HTTPS/);
    expect(() =>
      resolveWebOrigin({
        NODE_ENV: 'production',
        WEB_ORIGIN: 'https://staging.example.com/callback',
      }),
    ).toThrow(/without credentials, path, or query/);
  });
});
