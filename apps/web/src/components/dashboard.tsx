'use client';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import PauseRoundedIcon from '@mui/icons-material/PauseRounded';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded';
import SyncRoundedIcon from '@mui/icons-material/SyncRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import {
  Alert,
  AlertTitle,
  Avatar,
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
  IconButton,
  Skeleton,
  Snackbar,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import type {
  ChannelSummary,
  SubscriptionView,
  SyncRunAccepted,
  SyncRunStatus,
} from '@oshi-schedule/shared';
import { MAX_CHANNELS_PER_USER, channelHandleSchema } from '@oshi-schedule/shared';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiClientError, apiClient, pollSyncRun } from '@/lib/api';
import {
  dashboardConnectionNotice,
  type GoogleConnectionState,
  type SetupRecovery,
} from '@/lib/google-connection';
import { startGoogleOAuth } from '@/lib/google-oauth';
import { APP_ROUTES } from '@/lib/routes';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { publicEnv } from '@/lib/env';

const formatDate = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('ja-JP', { dateStyle: 'short', timeStyle: 'short' }).format(
        new Date(value),
      )
    : 'まだありません';

const channelDialogErrorMessage = (caught: unknown, action: 'resolve' | 'register') => {
  if (caught instanceof ApiClientError) {
    switch (caught.code) {
      case 'CHANNEL_NOT_FOUND':
        return '該当するYouTubeチャンネルが見つかりません。ハンドルを確認してください。';
      case 'DUPLICATE_CHANNEL':
        return 'このチャンネルはすでに登録されています。';
      case 'CHANNEL_LIMIT_REACHED':
        return '登録できるチャンネルは3件までです。';
      case 'VALIDATION_ERROR':
        return '@から始まる3〜30文字のハンドルを入力してください。';
      case 'YOUTUBE_QUOTA_DEFERRED':
      case 'YOUTUBE_QUOTA_OR_FORBIDDEN':
      case 'YOUTUBE_API_TIMEOUT':
      case 'YOUTUBE_API_UNAVAILABLE':
      case 'YOUTUBE_API_ERROR':
        return 'YouTubeからチャンネル情報を取得できませんでした。時間を置いて再試行してください。';
    }
  }
  return action === 'resolve'
    ? 'チャンネルを検索できませんでした。もう一度お試しください。'
    : 'チャンネルを登録できませんでした。もう一度お試しください。';
};

export function Dashboard({
  initialSetup = null,
  clearSetupQuery = false,
}: {
  initialSetup?: SetupRecovery;
  clearSetupQuery?: boolean;
}) {
  const router = useRouter();
  const [channels, setChannels] = useState<SubscriptionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState<GoogleConnectionState>({ status: 'loading' });
  const [setup] = useState<SetupRecovery>(initialSetup);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [handle, setHandle] = useState('');
  const [preview, setPreview] = useState<ChannelSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [syncStates, setSyncStates] = useState<Record<string, SyncRunStatus>>({});

  const loadConnection = useCallback(async () => {
    setConnection({ status: 'loading' });
    try {
      setConnection({ status: 'ready', me: await apiClient.me() });
    } catch {
      setConnection({ status: 'error' });
    }
  }, []);

  const load = useCallback(async () => {
    try {
      setChannels(await apiClient.channels());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '一覧を取得できません');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    void loadConnection();
  }, [load, loadConnection]);
  useEffect(() => {
    if (clearSetupQuery) router.replace(APP_ROUTES.dashboard, { scroll: false });
  }, [clearSetupQuery, router]);

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
  const connectionNotice = dashboardConnectionNotice(connection, setup);
  const act = async (key: string, action: () => Promise<unknown>, message: string) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      setNotice(message);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : '処理に失敗しました');
    } finally {
      setBusy(null);
    }
  };
  const resolve = async () => {
    setDialogError(null);
    const result = channelHandleSchema.safeParse(handle);
    if (!result.success) {
      setDialogError(result.error.issues[0]?.message ?? '入力を確認してください');
      return;
    }
    setBusy('resolve');
    try {
      setPreview(await apiClient.resolve(result.data));
    } catch (caught) {
      setDialogError(channelDialogErrorMessage(caught, 'resolve'));
    } finally {
      setBusy(null);
    }
  };
  const register = async () => {
    if (!preview) return;
    setBusy('register');
    setDialogError(null);
    try {
      const result = await apiClient.register(preview.youtubeChannelId);
      setDialogOpen(false);
      setPreview(null);
      setHandle('');
      await load();
      if (result.sync.status === 'FAILED') {
        setError('チャンネルを登録しましたが、初回同期を開始できませんでした。再試行してください');
      } else {
        setNotice('チャンネルを登録しました。初回同期を待機しています');
        void watchSync(
          {
            id: result.sync.id,
            subscriptionId: result.sync.subscriptionId,
            status: result.sync.status,
          },
          true,
        );
      }
    } catch (caught) {
      setDialogError(channelDialogErrorMessage(caught, 'register'));
    } finally {
      setBusy(null);
    }
  };
  const watchSync = async (accepted: SyncRunAccepted, initial = false) => {
    setSyncStates((current) => ({ ...current, [accepted.subscriptionId]: accepted.status }));
    try {
      const completed = await pollSyncRun(accepted.id, {
        onUpdate: (run) =>
          setSyncStates((current) => ({ ...current, [accepted.subscriptionId]: run.status })),
      });
      if (!completed) {
        setNotice('同期は続行中です。しばらくしてから画面を再読み込みしてください');
        return;
      }
      await load();
      if (completed.status === 'SUCCESS')
        setNotice(initial ? '初回同期が完了しました' : '同期が完了しました');
      else if (completed.status === 'DEFERRED')
        setNotice('同期は延期されました。時間を置いて再試行できます');
      else if (completed.status === 'FAILED')
        setError('同期に失敗しました。「今すぐ同期」から再試行してください');
    } catch {
      setError('同期状態を確認できませんでした。画面を再読み込みしてください');
    } finally {
      setSyncStates((current) => {
        const next = { ...current };
        delete next[accepted.subscriptionId];
        return next;
      });
    }
  };
  const requestSync = async (subscriptionId: string) => {
    setBusy(`sync-${subscriptionId}`);
    setError(null);
    try {
      const accepted = await apiClient.sync(subscriptionId);
      setNotice(accepted.status === 'RUNNING' ? '同期中です' : '同期を受け付けました');
      void watchSync(accepted);
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : '同期を開始できませんでした');
    } finally {
      setBusy(null);
    }
  };
  const openDialog = () => {
    setDialogError(null);
    setDialogOpen(true);
  };
  const closeDialog = () => {
    setDialogOpen(false);
    setDialogError(null);
    setPreview(null);
    setHandle('');
  };

  return (
    <Stack spacing={4}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        justifyContent="space-between"
        alignItems={{ xs: 'stretch', sm: 'center' }}
        spacing={2}
      >
        <Box>
          <Typography variant="h3" component="h1" sx={{ fontSize: { xs: '2rem', md: '2.6rem' } }}>
            おかえりなさい
          </Typography>
          <Typography color="text.secondary" mt={1}>
            推しの次の予定を、いつものカレンダーへ届けます。
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<AddRoundedIcon />}
          onClick={openDialog}
          disabled={channels.length >= MAX_CHANNELS_PER_USER}
        >
          チャンネルを追加
        </Button>
      </Stack>
      {connectionNotice && (
        <Alert
          severity={connectionNotice.severity}
          role={connectionNotice.severity === 'info' ? 'status' : 'alert'}
          action={
            connectionNotice.action ? (
              <Button
                color="inherit"
                size="small"
                onClick={() =>
                  connectionNotice.action === 'retry' ? void loadConnection() : void reconnect()
                }
              >
                {connectionNotice.action === 'retry' ? '再読み込み' : 'Googleを再連携'}
              </Button>
            ) : undefined
          }
        >
          <AlertTitle>{connectionNotice.title}</AlertTitle>
          {connectionNotice.message}
        </Alert>
      )}
      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="h6">登録チャンネル</Typography>
        <Chip
          label={`${channels.length} / ${MAX_CHANNELS_PER_USER}`}
          color={channels.length >= MAX_CHANNELS_PER_USER ? 'warning' : 'default'}
        />
      </Stack>
      {loading ? (
        <Stack spacing={2}>
          {[1, 2].map((item) => (
            <Skeleton key={item} variant="rounded" height={180} />
          ))}
        </Stack>
      ) : channels.length === 0 ? (
        <Card>
          <CardContent sx={{ py: 8, textAlign: 'center' }}>
            <Box
              sx={{
                mx: 'auto',
                mb: 2,
                width: 72,
                height: 72,
                borderRadius: '50%',
                display: 'grid',
                placeItems: 'center',
                bgcolor: '#fff0f5',
              }}
            >
              <AddRoundedIcon color="primary" fontSize="large" />
            </Box>
            <Typography variant="h6">最初の推しを登録しましょう</Typography>
            <Typography color="text.secondary" mt={1} mb={3}>
              YouTubeの @handle だけで始められます。
            </Typography>
            <Button variant="outlined" onClick={openDialog}>
              チャンネルを追加
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Stack spacing={2}>
          {channels.map((channel) => {
            const syncState = syncStates[channel.subscriptionId] ?? channel.lastSyncStatus;
            const syncActive = syncState === 'QUEUED' || syncState === 'RUNNING';
            return (
              <Card
                key={channel.subscriptionId}
                sx={{ opacity: channel.status === 'PAUSED' ? 0.72 : 1 }}
              >
                <CardContent>
                  <Stack
                    direction={{ xs: 'column', md: 'row' }}
                    spacing={2.5}
                    alignItems={{ xs: 'stretch', md: 'center' }}
                  >
                    <Stack direction="row" spacing={2} alignItems="center" flex={1}>
                      <Avatar src={channel.thumbnailUrl} alt="" sx={{ width: 64, height: 64 }} />
                      <Box minWidth={0}>
                        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                          <Typography variant="h6" noWrap>
                            {channel.title}
                          </Typography>
                          <Chip
                            size="small"
                            color={
                              syncActive
                                ? 'info'
                                : channel.status === 'ACTIVE'
                                  ? 'success'
                                  : 'default'
                            }
                            label={
                              syncState === 'QUEUED'
                                ? '待機中'
                                : syncState === 'RUNNING'
                                  ? '同期中'
                                  : channel.status === 'ACTIVE'
                                    ? '有効'
                                    : '一時停止'
                            }
                          />
                        </Stack>
                        <Typography color="text.secondary">{channel.handle}</Typography>
                      </Box>
                    </Stack>
                    <Stack
                      direction={{ xs: 'column', sm: 'row' }}
                      spacing={3}
                      sx={{ minWidth: { md: 350 } }}
                    >
                      <Box>
                        <Typography variant="caption" color="text.secondary">
                          最終取得
                        </Typography>
                        <Typography variant="body2">{formatDate(channel.lastFetchedAt)}</Typography>
                      </Box>
                      <Box>
                        <Typography variant="caption" color="text.secondary">
                          カレンダー反映
                        </Typography>
                        <Typography variant="body2">
                          {formatDate(channel.lastCalendarSyncAt)}
                        </Typography>
                      </Box>
                    </Stack>
                    <Stack direction="row" justifyContent="flex-end">
                      <Tooltip title="今すぐ同期">
                        <span>
                          <IconButton
                            aria-label={`${channel.title}を今すぐ同期`}
                            disabled={busy !== null || channel.status === 'PAUSED' || syncActive}
                            onClick={() => void requestSync(channel.subscriptionId)}
                          >
                            {busy === `sync-${channel.subscriptionId}` || syncActive ? (
                              <CircularProgress size={22} />
                            ) : (
                              <SyncRoundedIcon />
                            )}
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title={channel.status === 'ACTIVE' ? '一時停止' : '再開'}>
                        <span>
                          <IconButton
                            aria-label={
                              channel.status === 'ACTIVE'
                                ? `${channel.title}を一時停止`
                                : `${channel.title}を再開`
                            }
                            disabled={busy !== null}
                            onClick={() =>
                              void act(
                                `status-${channel.subscriptionId}`,
                                () =>
                                  apiClient.status(
                                    channel.subscriptionId,
                                    channel.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE',
                                  ),
                                channel.status === 'ACTIVE'
                                  ? '一時停止しました'
                                  : '同期を再開しました',
                              )
                            }
                          >
                            {channel.status === 'ACTIVE' ? (
                              <PauseRoundedIcon />
                            ) : (
                              <PlayArrowRoundedIcon />
                            )}
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="登録解除">
                        <span>
                          <IconButton
                            aria-label={`${channel.title}の登録を解除`}
                            color="error"
                            disabled={busy !== null}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `${channel.title} の登録を解除しますか？未来の予定はカレンダーから削除されます。`,
                                )
                              )
                                void act(
                                  `delete-${channel.subscriptionId}`,
                                  () => apiClient.remove(channel.subscriptionId),
                                  '登録を解除しました',
                                );
                            }}
                          >
                            <DeleteOutlineRoundedIcon />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </Stack>
                  </Stack>
                  {channel.lastErrorMessage && (
                    <Alert severity="warning" sx={{ mt: 2 }}>
                      {channel.lastErrorMessage}
                    </Alert>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </Stack>
      )}
      <Button
        startIcon={<RefreshRoundedIcon />}
        onClick={() => void load()}
        sx={{ alignSelf: 'center' }}
      >
        表示を更新
      </Button>
      <Dialog open={dialogOpen} onClose={() => !busy && closeDialog()} fullWidth maxWidth="sm">
        <DialogTitle>チャンネルを追加</DialogTitle>
        <DialogContent>
          <Stack spacing={3} pt={1}>
            {dialogError && (
              <Alert id="channel-dialog-error" severity="error" role="alert" aria-live="assertive">
                {dialogError}
              </Alert>
            )}
            <TextField
              autoFocus
              label="YouTube @handle"
              placeholder="@example"
              value={handle}
              onChange={(event) => {
                setHandle(event.target.value);
                setPreview(null);
              }}
              helperText="チャンネルURLではなく、@から始まるハンドルを入力してください"
              inputProps={{
                'aria-label': 'YouTube @handle',
                'aria-describedby': dialogError ? 'channel-dialog-error' : undefined,
              }}
            />
            {preview && (
              <Card variant="outlined">
                <CardContent>
                  <Stack direction="row" spacing={2} alignItems="center">
                    <Avatar src={preview.thumbnailUrl} alt="" sx={{ width: 60, height: 60 }} />
                    <Box>
                      <Typography fontWeight={800}>{preview.title}</Typography>
                      <Typography color="text.secondary">{preview.handle}</Typography>
                      <Typography
                        component="a"
                        href={preview.channelUrl}
                        target="_blank"
                        rel="noreferrer"
                        color="primary"
                        variant="body2"
                      >
                        YouTubeで確認
                      </Typography>
                    </Box>
                  </Stack>
                </CardContent>
              </Card>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog}>キャンセル</Button>
          {preview ? (
            <Button variant="contained" onClick={() => void register()} disabled={busy !== null}>
              {busy === 'register' ? (
                <Stack direction="row" spacing={1} alignItems="center">
                  <CircularProgress size={22} color="inherit" />
                  <span>登録して初回同期中…</span>
                </Stack>
              ) : (
                'このチャンネルを登録'
              )}
            </Button>
          ) : (
            <Button
              variant="contained"
              onClick={() => void resolve()}
              disabled={busy !== null || !handle}
            >
              {busy === 'resolve' ? <CircularProgress size={22} color="inherit" /> : '検索'}
            </Button>
          )}
        </DialogActions>
      </Dialog>
      <Snackbar
        open={Boolean(notice)}
        autoHideDuration={3500}
        onClose={() => setNotice(null)}
        message={notice}
      />
    </Stack>
  );
}
