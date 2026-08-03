import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';
import { sanitizeLogText, sanitizeLogValue } from './sanitize-log-data.js';

describe('log sanitization', () => {
  it('removes OAuth credentials from URLs while retaining the route and ordinary query data', () => {
    const value = sanitizeLogText(
      '/auth/callback?code=oauth-secret&next=%2Fdashboard&access_token=access-secret',
    );

    expect(value).toContain('/auth/callback?code=[REDACTED]');
    expect(value).toContain('next=%2Fdashboard');
    expect(value).toContain('access_token=[REDACTED]');
    expect(value).not.toContain('oauth-secret');
    expect(value).not.toContain('access-secret');
  });

  it('redacts secret fields and Bearer values but retains safe error correlation fields', () => {
    expect(
      sanitizeLogValue({
        errorCode: 'GOOGLE_CALENDAR_CREATE_FAILED',
        status: 502,
        authorization: 'Bearer bearer-secret',
        token: 'generic-secret',
        nested: { client_secret: 'client-secret' },
        message: 'GET /auth/callback?code=oauth-secret',
      }),
    ).toEqual({
      errorCode: 'GOOGLE_CALENDAR_CREATE_FAILED',
      status: 502,
      authorization: '[REDACTED]',
      token: '[REDACTED]',
      nested: { client_secret: '[REDACTED]' },
      message: 'GET /auth/callback?code=[REDACTED]',
    });
  });

  it('applies sanitization to actual structured logger output', () => {
    const output: string[] = [];
    const logger = createLogger({ write: (line) => output.push(line) });

    logger.info(
      {
        url: '/auth/callback?code=oauth-secret&next=%2Fdashboard',
        authorization: 'Bearer bearer-secret',
        errorCode: 'SAFE_ERROR_CODE',
        status: 307,
      },
      'redirecting /auth/callback?refresh_token=refresh-secret',
    );

    const line = output.join('');
    expect(line).toContain('/auth/callback?code=[REDACTED]');
    expect(line).toContain('next=%2Fdashboard');
    expect(line).toContain('SAFE_ERROR_CODE');
    expect(line).toContain('307');
    expect(line).not.toContain('oauth-secret');
    expect(line).not.toContain('bearer-secret');
    expect(line).not.toContain('refresh-secret');
  });
});
