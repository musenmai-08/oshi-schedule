'use client';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { AppRouterCacheProvider } from '@mui/material-nextjs/v15-appRouter';
import type { ReactNode } from 'react';

const theme = createTheme({
  palette: {
    primary: { main: '#e63e6d', dark: '#b91f4d', light: '#ff7898' },
    secondary: { main: '#5f49a7' },
    background: { default: '#fff9fb', paper: '#ffffff' },
    text: { primary: '#251c2b', secondary: '#716774' },
  },
  shape: { borderRadius: 14 },
  typography: {
    fontFamily: '"Hiragino Sans", "Yu Gothic", system-ui, sans-serif',
    h1: { fontWeight: 800 },
    h2: { fontWeight: 800 },
    h3: { fontWeight: 700 },
    button: { fontWeight: 700, textTransform: 'none' },
  },
  components: {
    MuiButton: { styleOverrides: { root: { minHeight: 44, borderRadius: 999 } } },
    MuiCard: {
      styleOverrides: {
        root: { border: '1px solid #f0e6eb', boxShadow: '0 12px 36px rgba(89, 36, 62, .07)' },
      },
    },
  },
});
export function Providers({ children }: { children: ReactNode }) {
  return (
    <AppRouterCacheProvider>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </AppRouterCacheProvider>
  );
}
