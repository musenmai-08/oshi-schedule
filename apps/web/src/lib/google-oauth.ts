import type { SupabaseClient } from '@supabase/supabase-js';
import { APP_ROUTES } from './routes';

export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';

export function googleOAuthOptions(origin: string) {
  return {
    redirectTo: `${origin}${APP_ROUTES.authCallback}`,
    scopes: GOOGLE_CALENDAR_SCOPE,
    queryParams: {
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    },
  } as const;
}

export async function startGoogleOAuth(client: SupabaseClient, origin: string) {
  return client.auth.signInWithOAuth({
    provider: 'google',
    options: googleOAuthOptions(origin),
  });
}
