'use client';
import FavoriteRoundedIcon from '@mui/icons-material/FavoriteRounded';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import { AppBar, Box, Button, Container, Stack, Toolbar, Typography } from '@mui/material';
import Link from 'next/link';
import type { ReactNode } from 'react';

export function AppShell({ children }: { children: ReactNode }) {
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
            <Link href="/dashboard">
              <Stack direction="row" alignItems="center" spacing={1}>
                <FavoriteRoundedIcon color="primary" />
                <Typography fontWeight={900}>推しスケジュール</Typography>
              </Stack>
            </Link>
            <Box flex={1} />
            <Button
              component={Link}
              href="/settings"
              color="inherit"
              startIcon={<SettingsOutlinedIcon />}
            >
              設定
            </Button>
          </Container>
        </Toolbar>
      </AppBar>
      <Container component="main" maxWidth="lg" sx={{ py: { xs: 4, md: 6 } }}>
        {children}
      </Container>
    </Box>
  );
}
