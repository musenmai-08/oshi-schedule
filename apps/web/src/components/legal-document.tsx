import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import FavoriteRoundedIcon from '@mui/icons-material/FavoriteRounded';
import { Box, Button, Container, Link as MuiLink, Paper, Stack, Typography } from '@mui/material';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { APP_ROUTES } from '@/lib/routes';

export interface LegalSection {
  title: string;
  content: ReactNode;
  link?: { label: string; href: string };
}

export function LegalDocument({
  title,
  effectiveDate,
  sections,
}: {
  title: string;
  effectiveDate: string;
  sections: LegalSection[];
}) {
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
                  制定日・最終更新日：{effectiveDate}
                </Typography>
              </Box>
              {sections.map((section) => (
                <Box component="section" key={section.title}>
                  <Typography component="h2" variant="h5" gutterBottom>
                    {section.title}
                  </Typography>
                  <Typography component="div" color="text.secondary" sx={{ lineHeight: 1.9 }}>
                    {section.content}
                  </Typography>
                  {section.link && (
                    <MuiLink href={section.link.href} target="_blank" rel="noreferrer">
                      {section.link.label}
                    </MuiLink>
                  )}
                </Box>
              ))}
            </Stack>
          </Paper>
        </Stack>
      </Container>
    </Box>
  );
}
