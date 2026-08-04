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
      title: 'Google Calendarの初回設定に失敗しました',
      message: 'Google Calendarへの接続を完了するため、もう一度Googleの権限を許可してください。',
      action: 'reconnect',
    };
  if (setup === 'reauth')
    return {
      severity: 'warning',
      title: 'Googleの再同意が必要です',
      message: 'カレンダー同期を再開するには、Googleを再連携してください。',
      action: 'reconnect',
    };
  if (state.status === 'loading')
    return {
      severity: 'info',
      title: 'Google接続を確認しています',
      message: '接続状態の確認が終わるまでお待ちください。',
      action: null,
    };
  if (state.status === 'error')
    return {
      severity: 'error',
      title: 'Google接続状態を確認できません',
      message: '通信状態を確認して、もう一度お試しください。',
      action: 'retry',
    };
  if (state.me.reauthRequired)
    return {
      severity: 'warning',
      title: 'Googleの再連携が必要です',
      message: 'Googleの認証が無効になっています。再連携するとカレンダー同期を再開できます。',
      action: 'reconnect',
    };
  if (!state.me.onboardingCompleted || state.me.calendarStatus !== 'ACTIVE')
    return {
      severity: 'warning',
      title: 'Google Calendarの接続が完了していません',
      message: 'Googleを連携して、専用カレンダーの初回設定を完了してください。',
      action: 'reconnect',
    };
  return null;
}

export function settingsConnectionView(state: GoogleConnectionState) {
  if (state.status === 'loading')
    return {
      chipLabel: '確認中',
      chipColor: 'default' as const,
      calendarLabel: '確認中…',
      notice: dashboardConnectionNotice(state, null),
    };
  if (state.status === 'error')
    return {
      chipLabel: '取得失敗',
      chipColor: 'error' as const,
      calendarLabel: '確認できません',
      notice: dashboardConnectionNotice(state, null),
    };
  if (state.me.reauthRequired)
    return {
      chipLabel: '再連携が必要',
      chipColor: 'warning' as const,
      calendarLabel:
        state.me.calendarStatus === 'ACTIVE' ? '接続情報あり（再認証が必要）' : '未設定',
      notice: dashboardConnectionNotice(state, null),
    };
  if (!state.me.onboardingCompleted || state.me.calendarStatus !== 'ACTIVE')
    return {
      chipLabel: '接続未完了',
      chipColor: 'warning' as const,
      calendarLabel: '未設定',
      notice: dashboardConnectionNotice(state, null),
    };
  return {
    chipLabel: '接続済み',
    chipColor: 'success' as const,
    calendarLabel: '推しスケジュール（有効）',
    notice: null,
  };
}
