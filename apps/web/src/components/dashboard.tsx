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
    ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      )
    : 'Not yet';

const channelDialogErrorMessage = (caught: unknown, action: 'resolve' | 'register') => {
  if (caught instanceof ApiClientError) {
    switch (caught.code) {
      case 'CHANNEL_NOT_FOUND':
        return 'No matching YouTube channel was found. Check the handle and try again.';
      case 'DUPLICATE_CHANNEL':
        return 'This channel is already registered.';
      case 'CHANNEL_LIMIT_REACHED':
        return 'You can register up to 3 channels.';
      case 'VALIDATION_ERROR':
        return 'Enter a 3–30 character handle beginning with @.';
      case 'YOUTUBE_QUOTA_DEFERRED':
      case 'YOUTUBE_QUOTA_OR_FORBIDDEN':
      case 'YOUTUBE_API_TIMEOUT':
      case 'YOUTUBE_API_UNAVAILABLE':
      case 'YOUTUBE_API_ERROR':
        return 'Failed to retrieve channel information from YouTube. Please try again later.';
    }
  }
  return action === 'resolve'
    ? 'Failed to find the channel. Please try again.'
    : 'Failed to add the channel. Please try again.';
};

const syncRequestErrorMessage = (caught: unknown) => {
  if (caught instanceof ApiClientError) {
    switch (caught.code) {
      case 'SYNC_COOLDOWN':
        return 'You can sync again 5 minutes after the previous sync.';
      case 'SYNC_ALREADY_RUNNING':
        return 'A sync is already in progress.';
      case 'SUBSCRIPTION_PAUSED':
        return 'This channel is paused. Resume it before syncing.';
      case 'GOOGLE_REAUTH_REQUIRED':
      case 'GOOGLE_RECONSENT_REQUIRED':
        return 'Reconnect Google to resume Calendar sync.';
    }
  }
  return 'Failed to start the sync. Please try again.';
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
    } catch {
      setError('Failed to load registered channels.');
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
      setError('Google reconnection is not available in demo mode.');
      return;
    }
    try {
      await startGoogleOAuth(createSupabaseBrowserClient(), window.location.origin);
    } catch {
      setError('Failed to start Google reconnection. Please try again.');
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
    } catch {
      setError('The operation could not be completed. Please try again.');
    } finally {
      setBusy(null);
    }
  };
  const resolve = async () => {
    setDialogError(null);
    const result = channelHandleSchema.safeParse(handle);
    if (!result.success) {
      setDialogError('Enter a 3–30 character handle beginning with @.');
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
        setError('The channel was added, but the initial sync could not be started. Please retry.');
      } else {
        setNotice('Channel added. The initial sync is queued.');
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
        setNotice('Sync is still in progress. Refresh the page in a few moments.');
        return;
      }
      await load();
      if (completed.status === 'SUCCESS')
        setNotice(
          initial
            ? 'Initial sync to Google Calendar completed successfully.'
            : 'Successfully synced to Google Calendar.',
        );
      else if (completed.status === 'DEFERRED')
        setNotice('Sync was deferred. You can try again later.');
      else if (completed.status === 'FAILED') setError('Sync failed. Select Sync Again to retry.');
    } catch {
      setError('Failed to retrieve the sync status. Please refresh the page.');
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
      setNotice(accepted.status === 'RUNNING' ? 'Sync in progress.' : 'Sync request accepted.');
      void watchSync(accepted);
    } catch (caught) {
      setError(syncRequestErrorMessage(caught));
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
            Welcome back
          </Typography>
          <Typography color="text.secondary" mt={1}>
            Keep your favorite creators&apos; upcoming streams in your calendar.
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<AddRoundedIcon />}
          onClick={openDialog}
          disabled={channels.length >= MAX_CHANNELS_PER_USER}
        >
          Add Channel
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
                {connectionNotice.action === 'retry' ? 'Retry' : 'Reconnect Google'}
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
        <Typography variant="h6">Registered Channels</Typography>
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
            <Typography variant="h6">Add your first channel</Typography>
            <Typography color="text.secondary" mt={1} mb={3}>
              Get started with a YouTube @handle.
            </Typography>
            <Button variant="outlined" onClick={openDialog}>
              Add Channel
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
                                ? 'Queued'
                                : syncState === 'RUNNING'
                                  ? 'Syncing'
                                  : channel.status === 'ACTIVE'
                                    ? 'Active'
                                    : 'Paused'
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
                          Last YouTube Fetch
                        </Typography>
                        <Typography variant="body2">{formatDate(channel.lastFetchedAt)}</Typography>
                      </Box>
                      <Box>
                        <Typography variant="caption" color="text.secondary">
                          Last Synced
                        </Typography>
                        <Typography variant="body2">
                          {formatDate(channel.lastCalendarSyncAt)}
                        </Typography>
                      </Box>
                    </Stack>
                    <Stack direction="row" justifyContent="flex-end">
                      <Tooltip title="Sync Again">
                        <span>
                          <IconButton
                            aria-label={`Sync ${channel.title} again`}
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
                      <Tooltip title={channel.status === 'ACTIVE' ? 'Pause' : 'Resume'}>
                        <span>
                          <IconButton
                            aria-label={
                              channel.status === 'ACTIVE'
                                ? `Pause ${channel.title}`
                                : `Resume ${channel.title}`
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
                                channel.status === 'ACTIVE' ? 'Channel paused.' : 'Sync resumed.',
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
                      <Tooltip title="Remove Channel">
                        <span>
                          <IconButton
                            aria-label={`Remove ${channel.title}`}
                            color="error"
                            disabled={busy !== null}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Remove ${channel.title}? Future events will be deleted from Google Calendar.`,
                                )
                              )
                                void act(
                                  `delete-${channel.subscriptionId}`,
                                  () => apiClient.remove(channel.subscriptionId),
                                  'Channel removed.',
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
                      The last sync attempt failed. Select Sync Again to retry.
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
        Refresh
      </Button>
      <Dialog open={dialogOpen} onClose={() => !busy && closeDialog()} fullWidth maxWidth="sm">
        <DialogTitle>Add Channel</DialogTitle>
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
              helperText="Enter the channel handle beginning with @, not the channel URL."
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
                        View on YouTube
                      </Typography>
                    </Box>
                  </Stack>
                </CardContent>
              </Card>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog}>Cancel</Button>
          {preview ? (
            <Button variant="contained" onClick={() => void register()} disabled={busy !== null}>
              {busy === 'register' ? (
                <Stack direction="row" spacing={1} alignItems="center">
                  <CircularProgress size={22} color="inherit" />
                  <span>Adding channel and starting initial sync…</span>
                </Stack>
              ) : (
                'Add This Channel'
              )}
            </Button>
          ) : (
            <Button
              variant="contained"
              onClick={() => void resolve()}
              disabled={busy !== null || !handle}
            >
              {busy === 'resolve' ? <CircularProgress size={22} color="inherit" /> : 'Find Channel'}
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
