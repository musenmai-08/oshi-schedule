import type { SupabaseClient } from '@supabase/supabase-js';
import { GOOGLE_OAUTH_REQUEST_SCOPES } from '@oshi-schedule/shared';
import { APP_ROUTES } from './routes';

export function googleOAuthOptions(origin: string) {
  return {
    redirectTo: `${origin}${APP_ROUTES.authCallback}`,
    scopes: GOOGLE_OAUTH_REQUEST_SCOPES.join(' '),
    queryParams: {
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'false',
    },
  } as const;
}

export async function startGoogleOAuth(client: SupabaseClient, origin: string) {
  return client.auth.signInWithOAuth({
    provider: 'google',
    options: googleOAuthOptions(origin),
  });
}
