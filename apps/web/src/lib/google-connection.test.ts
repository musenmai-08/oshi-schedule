import { describe, expect, it } from 'vitest';
import {
  dashboardConnectionNotice,
  parseSetupRecovery,
  settingsConnectionView,
  type GoogleConnectionState,
} from './google-connection';

const ready = (overrides: Partial<GoogleConnectionState & { status: 'ready' }> = {}) =>
  ({
    status: 'ready',
    me: {
      id: 'user',
      email: 'hidden@example.com',
      onboardingCompleted: true,
      reauthRequired: false,
      calendarStatus: 'ACTIVE',
    },
    ...overrides,
  }) as GoogleConnectionState;

describe('Google connection UI state', () => {
  it('accepts only fixed callback states and never reflects an arbitrary query value', () => {
    expect(parseSetupRecovery('failed')).toBe('failed');
    expect(parseSetupRecovery('reauth')).toBe('reauth');
    const injected = '<img src=x onerror=alert(1)>';
    expect(parseSetupRecovery(injected)).toBeNull();
    expect(
      JSON.stringify(dashboardConnectionNotice(ready(), parseSetupRecovery(injected))),
    ).not.toContain(injected);
  });

  it('shows fixed recovery actions for setup failure and re-consent', () => {
    expect(dashboardConnectionNotice(ready(), 'failed')).toMatchObject({
      severity: 'error',
      action: 'reconnect',
    });
    expect(dashboardConnectionNotice(ready(), 'reauth')).toMatchObject({
      severity: 'warning',
      action: 'reconnect',
    });
  });

  it('distinguishes loading, API failure, reauthentication and incomplete onboarding', () => {
    expect(dashboardConnectionNotice({ status: 'loading' }, null)?.action).toBeNull();
    expect(dashboardConnectionNotice({ status: 'error' }, null)?.action).toBe('retry');
    expect(
      dashboardConnectionNotice(
        ready({
          me: {
            id: 'user',
            email: 'hidden@example.com',
            onboardingCompleted: true,
            reauthRequired: true,
            calendarStatus: 'ACTIVE',
          },
        }),
        null,
      )?.action,
    ).toBe('reconnect');
    expect(
      dashboardConnectionNotice(
        ready({
          me: {
            id: 'user',
            email: 'hidden@example.com',
            onboardingCompleted: false,
            reauthRequired: false,
            calendarStatus: 'NOT_CONNECTED',
          },
        }),
        null,
      )?.title,
    ).toContain('完了していません');
    expect(dashboardConnectionNotice(ready(), null)).toBeNull();
  });

  it('does not report Settings as connected before data loads or after an API failure', () => {
    expect(settingsConnectionView({ status: 'loading' }).chipLabel).toBe('確認中');
    expect(settingsConnectionView({ status: 'error' }).chipLabel).toBe('取得失敗');
    expect(settingsConnectionView(ready()).chipLabel).toBe('接続済み');
  });
});
