'use client';
import GoogleIcon from '@mui/icons-material/Google';
import { Button } from '@mui/material';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { startGoogleOAuth } from '@/lib/google-oauth';
import { publicEnv } from '@/lib/env';
import { APP_ROUTES, DEMO_AUTH_COOKIE } from '@/lib/routes';

export function LoginButton() {
  const login = async () => {
    if (publicEnv.demoMode) {
      document.cookie = `${DEMO_AUTH_COOKIE}=1; Path=/; SameSite=Lax`;
      window.location.href = APP_ROUTES.dashboard;
      return;
    }
    await startGoogleOAuth(createSupabaseBrowserClient(), window.location.origin);
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
