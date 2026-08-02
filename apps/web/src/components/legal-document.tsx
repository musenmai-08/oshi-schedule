import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import FavoriteRoundedIcon from '@mui/icons-material/FavoriteRounded';
import { Alert, Box, Button, Container, Paper, Stack, Typography } from '@mui/material';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { APP_ROUTES } from '@/lib/routes';

interface LegalSection {
  title: string;
  content: ReactNode;
}

export function LegalDocument({ title, sections }: { title: string; sections: LegalSection[] }) {
  return (
    <Box component="main" minHeight="100vh" sx={{ py: { xs: 3, md: 7 } }}>
      <Container maxWidth="md">
        <Stack spacing={3}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <FavoriteRoundedIcon color="primary" />
            <Typography fontWeight={900}>推しスケジュール</Typography>
          </Stack>
          <Button
            component={Link}
            href={APP_ROUTES.root}
            startIcon={<ArrowBackRoundedIcon />}
            sx={{ alignSelf: 'flex-start' }}
          >
            ログイン画面に戻る
          </Button>
          <Paper component="article" sx={{ p: { xs: 3, md: 6 } }}>
            <Stack spacing={4}>
              <Box>
                <Typography component="h1" variant="h3">
                  {title}
                </Typography>
                <Typography color="text.secondary" mt={1}>
                  最終更新日：2026年8月2日
                </Typography>
              </Box>
              <Alert severity="warning">
                これは開発・動作確認用のデモ文面です。一般公開前に専門家による確認が必要です。
              </Alert>
              {sections.map((section) => (
                <Box component="section" key={section.title}>
                  <Typography component="h2" variant="h5" gutterBottom>
                    {section.title}
                  </Typography>
                  <Typography component="div" color="text.secondary" sx={{ lineHeight: 1.9 }}>
                    {section.content}
                  </Typography>
                </Box>
              ))}
            </Stack>
          </Paper>
        </Stack>
      </Container>
    </Box>
  );
}
