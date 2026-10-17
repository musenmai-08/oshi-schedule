import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import SyncIcon from '@mui/icons-material/Sync';
import { Box, Chip, Container, Link, Paper, Stack, Typography } from '@mui/material';
import NextLink from 'next/link';
import { LoginButton } from '@/components/login-button';
import { APP_ROUTES } from '@/lib/routes';
import {
  GOOGLE_CALENDAR_PERMISSION_NOTICE,
  GOOGLE_CALENDAR_PERMISSION_TITLE,
} from '@/lib/google-login-copy';

export default function LoginPage() {
  return (
    <Box
      component="main"
      sx={{
        minHeight: '100vh',
        overflow: 'hidden',
        position: 'relative',
        background:
          'radial-gradient(circle at 85% 15%, #ffe2eb 0, transparent 34%), radial-gradient(circle at 10% 85%, #eee7ff 0, transparent 35%)',
      }}
    >
      <Container
        maxWidth="lg"
        sx={{ minHeight: '100vh', display: 'grid', alignItems: 'center', py: 5 }}
      >
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={{ xs: 7, md: 12 }}
          alignItems="center"
        >
          <Stack spacing={3} flex={1}>
            <Chip
              icon={<AutoAwesomeIcon />}
              label="YouTube streams, synced to your calendar"
              color="secondary"
              variant="outlined"
              sx={{ alignSelf: 'flex-start', bgcolor: '#fff' }}
            />
            <Typography
              component="h1"
              variant="h1"
              sx={{
                fontSize: { xs: '2.8rem', md: '4.5rem' },
                lineHeight: 1.08,
                letterSpacing: '-.05em',
              }}
            >
              Never miss your
              <Box component="span" sx={{ color: 'primary.main' }}>
                favorite creator&apos;s stream.
              </Box>
            </Typography>
            <Typography
              color="text.secondary"
              sx={{ fontSize: { xs: '1.05rem', md: '1.2rem' }, lineHeight: 1.9, maxWidth: 570 }}
            >
              Automatically find upcoming YouTube live streams and premieres and add them to your
              dedicated Google Calendar.
            </Typography>
            <Stack spacing={1.25}>
              <LoginButton />
              <Box>
                <Typography variant="subtitle2">{GOOGLE_CALENDAR_PERMISSION_TITLE}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.7 }}>
                  {GOOGLE_CALENDAR_PERMISSION_NOTICE}
                </Typography>
              </Box>
            </Stack>
            <Typography variant="caption" color="text.secondary">
              You must be at least 13 years old to use this service. By signing in, you agree to the
              Terms of Service and Privacy Policy.
            </Typography>
          </Stack>
          <Paper
            elevation={0}
            sx={{
              width: { xs: '100%', md: 420 },
              p: { xs: 3, md: 4 },
              borderRadius: 6,
              transform: { md: 'rotate(2deg)' },
              border: '1px solid #f3dce5',
            }}
          >
            <Stack spacing={3}>
              <Typography variant="h5" fontWeight={800}>
                Upcoming Stream
              </Typography>
              <Box
                sx={{
                  p: 2.5,
                  borderRadius: 3,
                  bgcolor: '#fff1f5',
                  borderLeft: '5px solid #e63e6d',
                }}
              >
                <Typography variant="overline" color="primary">
                  YouTube Live
                </Typography>
                <Typography fontWeight={800}>A Summer Evening Live</Typography>
                <Typography variant="body2" color="text.secondary">
                  Jul 21, 8:00 PM — 9:00 PM
                </Typography>
              </Box>
              <Stack direction="row" spacing={2}>
                <CalendarMonthIcon color="secondary" />
                <Typography>Automatically added to your dedicated calendar</Typography>
              </Stack>
              <Stack direction="row" spacing={2}>
                <SyncIcon color="secondary" />
                <Typography>Updated hourly with the latest information</Typography>
              </Stack>
            </Stack>
          </Paper>
        </Stack>
      </Container>
      <Stack
        component="footer"
        direction="row"
        spacing={3}
        sx={{ position: 'absolute', bottom: 20, left: 0, right: 0, justifyContent: 'center' }}
      >
        <Link component={NextLink} href={APP_ROUTES.terms} color="text.secondary">
          Terms of Service
        </Link>
        <Link component={NextLink} href={APP_ROUTES.privacy} color="text.secondary">
          Privacy Policy
        </Link>
      </Stack>
    </Box>
  );
}
