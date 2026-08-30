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
              label="招待制プレビュー"
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
              推しの予定を、
              <Box component="span" sx={{ color: 'primary.main' }}>
                見逃さない。
              </Box>
            </Typography>
            <Typography
              color="text.secondary"
              sx={{ fontSize: { xs: '1.05rem', md: '1.2rem' }, lineHeight: 1.9, maxWidth: 570 }}
            >
              YouTubeのライブ配信とプレミア公開を自動で見つけて、あなた専用のGoogleカレンダーにまとめます。
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
              ログインすると、利用規約とプライバシーポリシーに同意したものとみなされます。
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
                次の配信
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
                <Typography fontWeight={800}>推しと過ごす夏の夜</Typography>
                <Typography variant="body2" color="text.secondary">
                  7月21日 20:00 — 21:00
                </Typography>
              </Box>
              <Stack direction="row" spacing={2}>
                <CalendarMonthIcon color="secondary" />
                <Typography>専用カレンダーに自動登録</Typography>
              </Stack>
              <Stack direction="row" spacing={2}>
                <SyncIcon color="secondary" />
                <Typography>1時間ごとに最新情報へ更新</Typography>
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
          利用規約
        </Link>
        <Link component={NextLink} href={APP_ROUTES.privacy} color="text.secondary">
          プライバシー
        </Link>
      </Stack>
    </Box>
  );
}
