'use client';
import DeleteForeverOutlinedIcon from '@mui/icons-material/DeleteForeverOutlined';
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
import { apiClient } from '@/lib/api';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

export function AccountSettings() {
  const [me, setMe] = useState<MeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    apiClient
      .me()
      .then(setMe)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : '設定を取得できません'),
      );
  }, []);
  const reconnect = async () => {
    if (process.env.NEXT_PUBLIC_DEMO_MODE === 'true') {
      setError('デモモードではGoogle再連携を実行しません');
      return;
    }
    await createSupabaseBrowserClient().auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        scopes: 'https://www.googleapis.com/auth/calendar',
        queryParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
      },
    });
  };
  const deleteAccount = async () => {
    setBusy(true);
    try {
      await apiClient.deleteAccount();
      if (process.env.NEXT_PUBLIC_DEMO_MODE !== 'true')
        await createSupabaseBrowserClient().auth.signOut();
      window.location.href = '/';
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '削除できませんでした');
      setBusy(false);
      setOpen(false);
    }
  };
  return (
    <Stack spacing={4} maxWidth={760}>
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
      <Card>
        <CardContent>
          <Stack spacing={2.5}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography variant="h6">Google連携</Typography>
              <Chip
                color={me?.reauthRequired ? 'warning' : 'success'}
                label={me?.reauthRequired ? '再連携が必要' : '接続済み'}
              />
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
              <Typography>
                {me?.calendarStatus === 'ACTIVE' ? '推しスケジュール（有効）' : '未設定'}
              </Typography>
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
