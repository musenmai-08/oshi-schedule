'use client';
import DeleteForeverOutlinedIcon from '@mui/icons-material/DeleteForeverOutlined';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import GoogleIcon from '@mui/icons-material/Google';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { MeView } from '@oshi-schedule/shared';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiClient } from '@/lib/api';
import { settingsConnectionView, type GoogleConnectionState } from '@/lib/google-connection';
import { startGoogleOAuth } from '@/lib/google-oauth';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { APP_ROUTES } from '@/lib/routes';
import { publicEnv } from '@/lib/env';

export function AccountSettings() {
  const [connection, setConnection] = useState<GoogleConnectionState>({ status: 'loading' });
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const loadConnection = async () => {
    setConnection({ status: 'loading' });
    try {
      setConnection({ status: 'ready', me: await apiClient.me() });
    } catch {
      setConnection({ status: 'error' });
    }
  };
  useEffect(() => {
    void loadConnection();
  }, []);
  const reconnect = async () => {
    if (publicEnv.demoMode) {
      setError('デモモードではGoogle再連携を実行しません');
      return;
    }
    try {
      await startGoogleOAuth(createSupabaseBrowserClient(), window.location.origin);
    } catch {
      setError('Google再連携を開始できませんでした。もう一度お試しください。');
    }
  };
  const deleteAccount = async () => {
    setBusy(true);
    try {
      await apiClient.deleteAccount();
      if (!publicEnv.demoMode) await createSupabaseBrowserClient().auth.signOut();
      window.location.href = '/';
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '削除できませんでした');
      setBusy(false);
      setOpen(false);
    }
  };
  const me: MeView | null = connection.status === 'ready' ? connection.me : null;
  const connectionView = settingsConnectionView(connection);
  return (
    <Stack spacing={4} maxWidth={760}>
      <Button
        component={Link}
        href={APP_ROUTES.dashboard}
        startIcon={<ArrowBackRoundedIcon />}
        sx={{ alignSelf: 'flex-start' }}
      >
        ダッシュボードに戻る
      </Button>
      <Box>
        <Typography variant="h3" component="h1" sx={{ fontSize: { xs: '2rem', md: '2.6rem' } }}>
          アカウント設定
        </Typography>
        <Typography color="text.secondary" mt={1}>
          Google連携と保存データを管理します。
        </Typography>
      </Box>
      {error && (
        <Alert severity="warning" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {connectionView.notice && (
        <Alert
          severity={connectionView.notice.severity}
          role={connectionView.notice.severity === 'info' ? 'status' : 'alert'}
          action={
            connectionView.notice.action === 'retry' ? (
              <Button color="inherit" size="small" onClick={() => void loadConnection()}>
                再読み込み
              </Button>
            ) : connectionView.notice.action === 'reconnect' ? (
              <Button color="inherit" size="small" onClick={() => void reconnect()}>
                Googleを再連携
              </Button>
            ) : undefined
          }
        >
          {connectionView.notice.message}
        </Alert>
      )}
      <Card>
        <CardContent>
          <Stack spacing={2.5}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography variant="h6">Google連携</Typography>
              <Chip color={connectionView.chipColor} label={connectionView.chipLabel} />
            </Stack>
            <Divider />
            <Box>
              <Typography variant="caption" color="text.secondary">
                登録メールアドレス
              </Typography>
              <Typography>{me?.email ?? '読み込み中…'}</Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">
                専用カレンダー
              </Typography>
              <Typography>{connectionView.calendarLabel}</Typography>
            </Box>
            <Button
              variant="outlined"
              startIcon={<GoogleIcon />}
              onClick={() => void reconnect()}
              sx={{ alignSelf: 'flex-start' }}
            >
              Googleを再連携
            </Button>
          </Stack>
        </CardContent>
      </Card>
      <Card sx={{ borderColor: '#ffc7d3' }}>
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h6" color="error">
              アカウント削除
            </Typography>
            <Typography color="text.secondary">
              登録チャンネル、同期情報、保存したGoogle認証情報と専用カレンダーを削除します。過去に別のカレンダーへコピーした予定は対象外です。
            </Typography>
            <Button
              color="error"
              variant="outlined"
              startIcon={<DeleteForeverOutlinedIcon />}
              onClick={() => setOpen(true)}
              sx={{ alignSelf: 'flex-start' }}
            >
              アカウントを削除
            </Button>
          </Stack>
        </CardContent>
      </Card>
      <Dialog open={open} onClose={() => !busy && setOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>本当に削除しますか？</DialogTitle>
        <DialogContent>
          <Alert severity="error" sx={{ mb: 3 }}>
            この操作は取り消せません。専用Googleカレンダーも削除されます。
          </Alert>
          <Typography mb={1}>
            確認のため <strong>DELETE</strong> と入力してください。
          </Typography>
          <TextField
            fullWidth
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            inputProps={{ 'aria-label': '削除確認' }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>キャンセル</Button>
          <Button
            color="error"
            variant="contained"
            disabled={confirmation !== 'DELETE' || busy}
            onClick={() => void deleteAccount()}
          >
            {busy ? <CircularProgress size={22} color="inherit" /> : '完全に削除する'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
