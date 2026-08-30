'use client';
import GoogleIcon from '@mui/icons-material/Google';
import { Button } from '@mui/material';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { startGoogleOAuth } from '@/lib/google-oauth';
import { publicEnv } from '@/lib/env';
import { APP_ROUTES, DEMO_AUTH_COOKIE } from '@/lib/routes';
import { GOOGLE_LOGIN_LABEL } from '@/lib/google-login-copy';
import { GOOGLE_BRANDED_BUTTON_SX } from './google-brand';

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
      variant="outlined"
      size="large"
      startIcon={<GoogleIcon />}
      sx={GOOGLE_BRANDED_BUTTON_SX}
    >
      {GOOGLE_LOGIN_LABEL}
    </Button>
  );
}
