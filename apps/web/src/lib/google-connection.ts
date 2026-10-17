import type { MeView } from '@oshi-schedule/shared';

export type SetupRecovery = 'failed' | 'reauth' | null;
export type GoogleConnectionState =
  { status: 'loading' } | { status: 'ready'; me: MeView } | { status: 'error' };

export interface ConnectionNotice {
  severity: 'info' | 'warning' | 'error';
  title: string;
  message: string;
  action: 'reconnect' | 'retry' | null;
}

export function parseSetupRecovery(value: string | string[] | undefined): SetupRecovery {
  return value === 'failed' || value === 'reauth' ? value : null;
}

export function dashboardConnectionNotice(
  state: GoogleConnectionState,
  setup: SetupRecovery,
): ConnectionNotice | null {
  if (setup === 'failed')
    return {
      severity: 'error',
      title: 'Google Calendar setup failed',
      message: 'Allow Google access again to complete the Google Calendar connection.',
      action: 'reconnect',
    };
  if (setup === 'reauth')
    return {
      severity: 'warning',
      title: 'Google authorization is required again',
      message: 'Reconnect Google to resume Calendar sync.',
      action: 'reconnect',
    };
  if (state.status === 'loading')
    return {
      severity: 'info',
      title: 'Checking Google connection',
      message: 'Please wait while we check the connection status.',
      action: null,
    };
  if (state.status === 'error')
    return {
      severity: 'error',
      title: 'Could not check the Google connection',
      message: 'Check your connection and try again.',
      action: 'retry',
    };
  if (state.me.reauthRequired)
    return {
      severity: 'warning',
      title: 'Google reconnection required',
      message: 'Your Google authorization is no longer valid. Reconnect to resume Calendar sync.',
      action: 'reconnect',
    };
  if (!state.me.onboardingCompleted || state.me.calendarStatus !== 'ACTIVE')
    return {
      severity: 'warning',
      title: 'Google Calendar connection is incomplete',
      message: 'Connect Google to finish setting up your dedicated calendar.',
      action: 'reconnect',
    };
  return null;
}

export function settingsConnectionView(state: GoogleConnectionState) {
  if (state.status === 'loading')
    return {
      chipLabel: 'Checking',
      chipColor: 'default' as const,
      calendarLabel: 'Checking…',
      notice: dashboardConnectionNotice(state, null),
    };
  if (state.status === 'error')
    return {
      chipLabel: 'Unavailable',
      chipColor: 'error' as const,
      calendarLabel: 'Could not be verified',
      notice: dashboardConnectionNotice(state, null),
    };
  if (state.me.reauthRequired)
    return {
      chipLabel: 'Reconnect required',
      chipColor: 'warning' as const,
      calendarLabel:
        state.me.calendarStatus === 'ACTIVE'
          ? 'Connection found (reauthorization required)'
          : 'Not set up',
      notice: dashboardConnectionNotice(state, null),
    };
  if (!state.me.onboardingCompleted || state.me.calendarStatus !== 'ACTIVE')
    return {
      chipLabel: 'Connection incomplete',
      chipColor: 'warning' as const,
      calendarLabel: 'Not set up',
      notice: dashboardConnectionNotice(state, null),
    };
  return {
    chipLabel: 'Connected',
    chipColor: 'success' as const,
    calendarLabel: 'Oshi Schedule (active)',
    notice: null,
  };
}
