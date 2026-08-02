'use client';
import FavoriteRoundedIcon from '@mui/icons-material/FavoriteRounded';
import LogoutRoundedIcon from '@mui/icons-material/LogoutRounded';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import {
  Alert,
  AppBar,
  Box,
  Button,
  CircularProgress,
  Container,
  Snackbar,
  Stack,
  Toolbar,
  Typography,
} from '@mui/material';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useRef, useState } from 'react';
import { signOutSession } from '@/lib/auth-actions';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { APP_ROUTES, DEMO_AUTH_COOKIE } from '@/lib/routes';

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const logoutInFlight = useRef(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const logout = async () => {
    if (logoutInFlight.current) return;
    logoutInFlight.current = true;
    setLoggingOut(true);
    setLogoutError(null);
    try {
      if (process.env.NEXT_PUBLIC_DEMO_MODE === 'true') {
        document.cookie = `${DEMO_AUTH_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
      } else {
        const supabase = createSupabaseBrowserClient();
        await signOutSession(() => supabase.auth.signOut());
      }
      router.replace(APP_ROUTES.root);
      router.refresh();
    } catch {
      setLogoutError('ログアウトできませんでした。もう一度お試しください。');
    } finally {
      logoutInFlight.current = false;
      setLoggingOut(false);
    }
  };
  return (
    <Box minHeight="100vh">
      <AppBar
        position="sticky"
        color="inherit"
        elevation={0}
        sx={{
          borderBottom: '1px solid #f0e6eb',
          bgcolor: 'rgba(255,255,255,.9)',
          backdropFilter: 'blur(12px)',
        }}
      >
        <Toolbar>
          <Container maxWidth="lg" sx={{ display: 'flex', alignItems: 'center' }}>
            <Link href={APP_ROUTES.dashboard}>
              <Stack direction="row" alignItems="center" spacing={1}>
                <FavoriteRoundedIcon color="primary" />
                <Typography fontWeight={900}>推しスケジュール</Typography>
              </Stack>
            </Link>
            <Box flex={1} />
            <Button
              component={Link}
              href={APP_ROUTES.settings}
              color="inherit"
              startIcon={<SettingsOutlinedIcon />}
            >
              設定
            </Button>
            <Button
              color="inherit"
              startIcon={loggingOut ? <CircularProgress size={18} /> : <LogoutRoundedIcon />}
              disabled={loggingOut}
              onClick={() => void logout()}
            >
              {loggingOut ? 'ログアウト中…' : 'ログアウト'}
            </Button>
          </Container>
        </Toolbar>
      </AppBar>
      <Container component="main" maxWidth="lg" sx={{ py: { xs: 4, md: 6 } }}>
        {children}
      </Container>
      <Snackbar
        open={Boolean(logoutError)}
        autoHideDuration={5000}
        onClose={() => setLogoutError(null)}
      >
        <Alert severity="error" onClose={() => setLogoutError(null)} role="alert">
          {logoutError}
        </Alert>
      </Snackbar>
    </Box>
  );
}
