import { describe, expect, it, vi } from 'vitest';
import { handleAuthCallback } from './auth-callback';

const internalRequest = (query = '') => new Request(`https://localhost:3000/auth/callback${query}`);

const session = {
  access_token: 'supabase-access-token',
  provider_refresh_token: 'google-refresh-token',
};

type CallbackDependencies = Parameters<typeof handleAuthCallback>[1];

const dependencies = (
  exchangeCodeForSession: CallbackDependencies['exchangeCodeForSession'] = vi.fn(async () => ({
    data: { session },
    error: null,
  })),
  fetch: CallbackDependencies['fetch'] = vi.fn(async () => new Response(null, { status: 200 })),
) => ({
  webOrigin: 'https://staging.oshi-schedule.com',
  apiUrl: 'https://api-staging.oshi-schedule.com',
  exchangeCodeForSession,
  fetch,
});

describe('Google OAuth callback redirects', () => {
  it('redirects a successful callback to the canonical dashboard origin', async () => {
    const deps = dependencies();
    const response = await handleAuthCallback(internalRequest('?code=oauth-code'), deps);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://staging.oshi-schedule.com/dashboard');
    expect(deps.fetch).toHaveBeenCalledWith(
      'https://api-staging.oshi-schedule.com/api/v1/onboarding',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ providerRefreshToken: 'google-refresh-token' }),
      }),
    );
  });

  it('redirects a missing or rejected code to the canonical OAuth error URL', async () => {
    const noCode = dependencies();
    const missingCodeResponse = await handleAuthCallback(internalRequest(), noCode);
    expect(missingCodeResponse.headers.get('location')).toBe(
      'https://staging.oshi-schedule.com/?error=oauth',
    );
    expect(noCode.exchangeCodeForSession).not.toHaveBeenCalled();

    const rejected = dependencies(
      vi.fn(async () => ({ data: { session: null }, error: new Error('exchange failed') })),
    );
    const rejectedResponse = await handleAuthCallback(internalRequest('?code=invalid'), rejected);
    expect(rejectedResponse.headers.get('location')).toBe(
      'https://staging.oshi-schedule.com/?error=oauth',
    );
  });

  it('keeps onboarding recovery redirects on the canonical origin', async () => {
    const onboardingFailed = dependencies(
      undefined,
      vi.fn(async () => new Response(null, { status: 502 })),
    );
    const failedResponse = await handleAuthCallback(
      internalRequest('?code=oauth-code'),
      onboardingFailed,
    );
    expect(failedResponse.headers.get('location')).toBe(
      'https://staging.oshi-schedule.com/dashboard?setup=failed',
    );

    const scopeRejected = dependencies(
      undefined,
      vi.fn(async () =>
        Response.json(
          { error: { code: 'GOOGLE_RECONSENT_REQUIRED', message: 'reconsent' } },
          { status: 401 },
        ),
      ),
    );
    const scopeRejectedResponse = await handleAuthCallback(
      internalRequest('?code=oauth-code'),
      scopeRejected,
    );
    expect(scopeRejectedResponse.headers.get('location')).toBe(
      'https://staging.oshi-schedule.com/dashboard?setup=reauth',
    );

    const reauth = dependencies(
      vi.fn(async () => ({
        data: { session: { ...session, provider_refresh_token: null } },
        error: null,
      })),
    );
    const reauthResponse = await handleAuthCallback(internalRequest('?code=oauth-code'), reauth);
    expect(reauthResponse.headers.get('location')).toBe(
      'https://staging.oshi-schedule.com/dashboard?setup=reauth',
    );
  });
});
