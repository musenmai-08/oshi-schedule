import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { APP_ROUTES } from '@/lib/routes';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const destination = new URL(APP_ROUTES.dashboard, url.origin);
  if (!code)
    return NextResponse.redirect(new URL(`${APP_ROUTES.root}?error=oauth`, url.origin));
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.session)
    return NextResponse.redirect(new URL(`${APP_ROUTES.root}?error=oauth`, url.origin));
  if (data.session.provider_refresh_token) {
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/v1/onboarding`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${data.session.access_token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          providerRefreshToken: data.session.provider_refresh_token,
          providerAccessToken: data.session.provider_token,
        }),
      },
    );
    if (!response.ok) destination.searchParams.set('setup', 'failed');
  } else destination.searchParams.set('setup', 'reauth');
  return NextResponse.redirect(destination);
}
