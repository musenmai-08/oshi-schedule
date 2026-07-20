import { APP_NAME } from '@oshi-schedule/shared';
import { AppError } from '../../domain/errors.js';
import type { CalendarEventInput } from '../../domain/scheduling.js';
import type { CalendarGateway, Store, TokenCipher, UserRecord } from '../../application/models.js';

export class GoogleCalendarGateway implements CalendarGateway {
  constructor(
    private readonly store: Store,
    private readonly cipher: TokenCipher,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly timeoutMs = 10_000,
  ) {}
  private async accessToken(userId: string) {
    const encrypted = await this.store.getEncryptedCredential(userId);
    if (!encrypted) throw new AppError('GOOGLE_REAUTH_REQUIRED', 'Googleの再連携が必要です', 401);
    const refreshToken = this.cipher.decrypt(encrypted);
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      await this.store.markReauthRequired(userId);
      throw new AppError('GOOGLE_REAUTH_REQUIRED', 'Googleの再連携が必要です', 401);
    }
    const body = (await response.json()) as { access_token?: string };
    if (!body.access_token)
      throw new AppError('GOOGLE_TOKEN_ERROR', 'Googleへ接続できません', 502, true);
    return body.access_token;
  }
  private async request(userId: string, path: string, init: RequestInit = {}) {
    const token = await this.accessToken(userId);
    return fetch(`https://www.googleapis.com/calendar/v3${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...init.headers,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
  async ensureCalendar(user: UserRecord) {
    if (user.calendarId) {
      const check = await this.request(
        user.id,
        `/calendars/${encodeURIComponent(user.calendarId)}`,
      );
      if (check.ok) return user.calendarId;
      if (![404, 410].includes(check.status))
        throw new AppError(
          'GOOGLE_CALENDAR_ERROR',
          'カレンダーを確認できません',
          502,
          check.status >= 500,
        );
    }
    const response = await this.request(user.id, '/calendars', {
      method: 'POST',
      body: JSON.stringify({ summary: APP_NAME, timeZone: 'Asia/Tokyo' }),
    });
    if (!response.ok)
      throw new AppError(
        'GOOGLE_CALENDAR_CREATE_FAILED',
        '専用カレンダーを作成できません',
        502,
        response.status >= 500,
      );
    const body = (await response.json()) as { id?: string };
    if (!body.id)
      throw new AppError('GOOGLE_CALENDAR_CREATE_FAILED', '専用カレンダーを作成できません', 502);
    await this.store.setCalendarId(user.id, body.id);
    return body.id;
  }
  private eventBody(event: CalendarEventInput) {
    return {
      summary: event.summary,
      description: event.description,
      start: { dateTime: event.start },
      end: { dateTime: event.end },
      status: event.status,
      extendedProperties: event.extendedProperties,
    };
  }
  async upsertEvent(
    user: UserRecord,
    calendarId: string,
    eventId: string | null,
    event: CalendarEventInput,
  ) {
    if (eventId) {
      const patched = await this.request(
        user.id,
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        { method: 'PATCH', body: JSON.stringify(this.eventBody(event)) },
      );
      if (patched.ok) return eventId;
      if (![404, 410].includes(patched.status))
        throw new AppError(
          'GOOGLE_EVENT_UPDATE_FAILED',
          '予定を更新できません',
          502,
          patched.status >= 500,
        );
    }
    const created = await this.request(
      user.id,
      `/calendars/${encodeURIComponent(calendarId)}/events`,
      { method: 'POST', body: JSON.stringify(this.eventBody(event)) },
    );
    if (!created.ok)
      throw new AppError(
        'GOOGLE_EVENT_CREATE_FAILED',
        '予定を作成できません',
        502,
        created.status >= 500,
      );
    const body = (await created.json()) as { id?: string };
    if (!body.id) throw new AppError('GOOGLE_EVENT_CREATE_FAILED', '予定を作成できません', 502);
    return body.id;
  }
  async deleteEvent(user: UserRecord, calendarId: string, eventId: string) {
    const response = await this.request(
      user.id,
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: 'DELETE' },
    );
    if (!response.ok && ![404, 410].includes(response.status))
      throw new AppError('GOOGLE_EVENT_DELETE_FAILED', '未来の予定を削除できません', 502);
  }
  async deleteCalendar(user: UserRecord, calendarId: string) {
    const response = await this.request(user.id, `/calendars/${encodeURIComponent(calendarId)}`, {
      method: 'DELETE',
    });
    if (!response.ok && ![404, 410].includes(response.status))
      throw new AppError('GOOGLE_CALENDAR_DELETE_FAILED', '専用カレンダーを削除できません', 502);
  }
  async revokeAuthorization(user: UserRecord) {
    const encrypted = await this.store.getEncryptedCredential(user.id);
    if (!encrypted) return;
    const response = await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: this.cipher.decrypt(encrypted) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok && response.status !== 400)
      throw new AppError(
        'GOOGLE_REVOKE_FAILED',
        'Google連携を解除できません',
        502,
        response.status >= 500,
      );
  }
}
