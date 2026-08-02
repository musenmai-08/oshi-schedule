'use client';
import GoogleIcon from '@mui/icons-material/Google';
import { Button } from '@mui/material';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { APP_ROUTES, DEMO_AUTH_COOKIE } from '@/lib/routes';

export function LoginButton() {
  const login = async () => {
    if (process.env.NEXT_PUBLIC_DEMO_MODE === 'true') {
      document.cookie = `${DEMO_AUTH_COOKIE}=1; Path=/; SameSite=Lax`;
      window.location.href = APP_ROUTES.dashboard;
      return;
    }
    const callback = `${window.location.origin}${APP_ROUTES.authCallback}`;
    await createSupabaseBrowserClient().auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: callback,
        scopes: 'https://www.googleapis.com/auth/calendar',
        queryParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
      },
    });
  };
  return (
    <Button
      onClick={login}
      variant="contained"
      size="large"
      startIcon={<GoogleIcon />}
      sx={{ px: 4, boxShadow: '0 10px 24px rgba(230,62,109,.25)' }}
    >
      Googleでログイン
    </Button>
  );
}
