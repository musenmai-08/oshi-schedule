import { NextResponse } from 'next/server';
import { APP_ROUTES } from './routes';

interface CallbackSession {
  access_token: string;
  provider_refresh_token?: string | null;
}

interface AuthCallbackDependencies {
  webOrigin: string;
  apiUrl: string;
  exchangeCodeForSession: (
    code: string,
  ) => Promise<{ data: { session: CallbackSession | null }; error: unknown }>;
  fetch: typeof globalThis.fetch;
}

export async function handleAuthCallback(request: Request, dependencies: AuthCallbackDependencies) {
  const code = new URL(request.url).searchParams.get('code');
  const oauthFailure = new URL(`${APP_ROUTES.root}?error=oauth`, dependencies.webOrigin);
  if (!code) return NextResponse.redirect(oauthFailure);

  const { data, error } = await dependencies.exchangeCodeForSession(code);
  if (error || !data.session) return NextResponse.redirect(oauthFailure);

  const destination = new URL(APP_ROUTES.dashboard, dependencies.webOrigin);
  if (data.session.provider_refresh_token) {
    const response = await dependencies.fetch(`${dependencies.apiUrl}/api/v1/onboarding`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${data.session.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        providerRefreshToken: data.session.provider_refresh_token,
      }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { code?: string };
      } | null;
      destination.searchParams.set(
        'setup',
        body?.error?.code === 'GOOGLE_RECONSENT_REQUIRED' ||
          body?.error?.code === 'GOOGLE_REAUTH_REQUIRED'
          ? 'reauth'
          : 'failed',
      );
    }
  } else destination.searchParams.set('setup', 'reauth');
  return NextResponse.redirect(destination);
}
