import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleCalendarGateway } from './google-calendar-gateway.js';
import { MemoryStore } from '../database/memory-store.js';
import { AesTokenCipher } from '../encryption/aes-token-cipher.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const grantedScope =
  'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/calendar.app.created';
const token = (accessToken = 'access-token', scope = grantedScope) => ({
  access_token: accessToken,
  expires_in: 3600,
  scope,
});

async function setup() {
  const store = new MemoryStore();
  const user = await store.ensureUser({ subject: 'google-user', email: 'developer@example.com' });
  const cipher = new AesTokenCipher(`v1:${Buffer.alloc(32, 6).toString('base64')}`);
  const encrypted = cipher.encrypt('refresh-token');
  await store.completeOnboarding(
    user.id,
    encrypted.ciphertext,
    encrypted.keyId,
    'calendar-id',
    'openid email profile https://www.googleapis.com/auth/calendar.app.created',
  );
  return {
    store,
    user: (await store.findUserById(user.id))!,
    gateway: new GoogleCalendarGateway(
      store,
      cipher,
      'client',
      'secret',
      10_000,
      async () => undefined,
    ),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('GoogleCalendarGateway token refresh', () => {
  it('marks reauthentication only for invalid_grant', async () => {
    const { store, user, gateway } = await setup();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(json({ error: 'invalid_grant' }, 400)),
    );
    await expect(gateway.eventExists(user, 'calendar-id', 'event-id')).rejects.toMatchObject({
      code: 'GOOGLE_REAUTH_REQUIRED',
    });
    expect((await store.findUserById(user.id))?.reauthRequired).toBe(true);
  });

  it('keeps a transient token error retryable and does not require reauthentication', async () => {
    const { store, user, gateway } = await setup();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ error: 'server_error' }, 500));
    vi.stubGlobal('fetch', fetchMock);
    await expect(gateway.eventExists(user, 'calendar-id', 'event-id')).rejects.toMatchObject({
      code: 'GOOGLE_TOKEN_ERROR',
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((await store.findUserById(user.id))?.reauthRequired).toBe(false);
  });

  it('does not retry or require reauthentication for invalid_client', async () => {
    const { store, user, gateway } = await setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ error: 'invalid_client' }, 400));
    vi.stubGlobal('fetch', fetchMock);
    await expect(gateway.eventExists(user, 'calendar-id', 'event-id')).rejects.toMatchObject({
      code: 'GOOGLE_TOKEN_ERROR',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await store.findUserById(user.id))?.reauthRequired).toBe(false);
  });

  it('validates and normalizes the scopes actually granted to the refresh token', async () => {
    const { store, user, gateway } = await setup();
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          json(
            token(
              'verified-token',
              'profile openid https://www.googleapis.com/auth/calendar.app.created email',
            ),
          ),
        ),
    );

    await expect(gateway.verifyGrant(user.id, 'new-refresh-token')).resolves.toBe(
      'email https://www.googleapis.com/auth/calendar.app.created openid profile',
    );
    expect((await store.findUserById(user.id))?.reauthRequired).toBe(false);
  });

  it.each([
    ['missing app-created scope', 'openid email profile'],
    [
      'old broad Calendar grant mixed in',
      `${grantedScope} https://www.googleapis.com/auth/calendar`,
    ],
  ])('requires re-consent for %s', async (_label, scope) => {
    const { store, user, gateway } = await setup();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(json(token('overprivileged-token', scope))),
    );

    await expect(gateway.verifyGrant(user.id, 'new-refresh-token')).rejects.toMatchObject({
      code: 'GOOGLE_RECONSENT_REQUIRED',
      status: 401,
    });
    expect((await store.findUserById(user.id))?.reauthRequired).toBe(true);
  });

  it('retries bounded transient responses and network failures', async () => {
    const first = await setup();
    const recoveringFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 429))
      .mockResolvedValueOnce(json(token('recovered')))
      .mockResolvedValueOnce(json({ id: 'event-id' }));
    vi.stubGlobal('fetch', recoveringFetch);
    await expect(first.gateway.eventExists(first.user, 'calendar-id', 'event-id')).resolves.toBe(
      true,
    );

    const second = await setup();
    const timeoutFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('timeout'));
    vi.stubGlobal('fetch', timeoutFetch);
    await expect(
      second.gateway.eventExists(second.user, 'calendar-id', 'event-id'),
    ).rejects.toMatchObject({
      code: 'GOOGLE_TOKEN_ERROR',
      retryable: true,
    });
    expect(timeoutFetch).toHaveBeenCalledTimes(3);
  });

  it('classifies a bounded token endpoint timeout separately', async () => {
    const { user, gateway } = await setup();
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(timeout);
    vi.stubGlobal('fetch', fetchMock);
    await expect(gateway.eventExists(user, 'calendar-id', 'event-id')).rejects.toMatchObject({
      code: 'GOOGLE_TOKEN_TIMEOUT',
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reuses one access token for multiple Calendar requests', async () => {
    const { user, gateway } = await setup();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes('oauth2.googleapis.com/token')) return json(token());
      return json({ id: 'event-id' });
    });
    vi.stubGlobal('fetch', fetchMock);
    await gateway.eventExists(user, 'calendar-id', 'event-1');
    await gateway.eventExists(user, 'calendar-id', 'event-2');
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).includes('oauth2.googleapis.com/token'),
      ),
    ).toHaveLength(1);
  });

  it('treats an HTTP 200 cancelled event tombstone as deleted', async () => {
    const { user, gateway } = await setup();
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json(token()))
        .mockResolvedValueOnce(json({ id: 'event-id', status: 'cancelled' })),
    );

    await expect(gateway.eventExists(user, 'calendar-id', 'event-id')).resolves.toBe(false);
  });

  it('uses exponential delay with jitter and honors Retry-After', async () => {
    const store = new MemoryStore();
    const user = await store.ensureUser({ subject: 'retry-user', email: 'developer@example.com' });
    const cipher = new AesTokenCipher(`v1:${Buffer.alloc(32, 6).toString('base64')}`);
    const encrypted = cipher.encrypt('refresh-token');
    await store.completeOnboarding(
      user.id,
      encrypted.ciphertext,
      encrypted.keyId,
      'calendar-id',
      'openid email profile https://www.googleapis.com/auth/calendar.app.created',
    );
    const delays: number[] = [];
    const gateway = new GoogleCalendarGateway(
      store,
      cipher,
      'client',
      'secret',
      10_000,
      async (delay) => void delays.push(delay),
      1_000,
      () => 0.5,
    );
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'rate_limited' }), {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': '3' },
          }),
        )
        .mockResolvedValueOnce(json(token('token')))
        .mockResolvedValueOnce(json({ id: 'event-id' })),
    );
    await expect(
      gateway.eventExists((await store.findUserById(user.id))!, 'calendar-id', 'event-id'),
    ).resolves.toBe(true);
    expect(delays).toEqual([3_000]);
  });

  it('classifies Calendar and revoke timeouts separately for resumable deletion', async () => {
    const calendar = await setup();
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json(token('token')))
        .mockRejectedValueOnce(timeout),
    );
    await expect(
      calendar.gateway.deleteCalendar(calendar.user, 'calendar-id'),
    ).rejects.toMatchObject({
      code: 'GOOGLE_CALENDAR_TIMEOUT',
      retryable: true,
    });

    const revoke = await setup();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(timeout));
    await expect(revoke.gateway.revokeAuthorization(revoke.user)).rejects.toMatchObject({
      code: 'GOOGLE_REVOKE_TIMEOUT',
      retryable: true,
    });
  });

  it('recreates a deleted calendar and treats already-deleted calendar/token as idempotent', async () => {
    const { user, gateway } = await setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(token('token')))
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json({ id: 'replacement-calendar' }))
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json({}, 400));
    vi.stubGlobal('fetch', fetchMock);
    await expect(gateway.ensureCalendar(user)).resolves.toBe('replacement-calendar');
    await expect(gateway.deleteCalendar(user, 'already-deleted')).resolves.toBeUndefined();
    await expect(gateway.revokeAuthorization(user)).resolves.toBeUndefined();
  });

  it('resolves a deterministic insert conflict by patching the same event', async () => {
    const { user, gateway } = await setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(token('token')))
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json({}, 409))
      .mockResolvedValueOnce(json({ id: 'stable-event' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      gateway.upsertEvent(
        user,
        'calendar-id',
        'stable-event',
        {
          summary: '配信',
          description: 'description',
          start: '2026-07-21T10:00:00.000Z',
          end: '2026-07-21T11:00:00.000Z',
          status: 'confirmed',
          extendedProperties: { private: { source: 'oshi-schedule' } },
        },
        true,
      ),
    ).resolves.toBe('stable-event');
  });

  it('keeps every Calendar operation within the calendar.app.created scope contract', async () => {
    const { user, gateway } = await setup();
    const calls: Array<{ method: string; path: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input));
        if (url.hostname === 'oauth2.googleapis.com') return json(token());
        const method = init?.method ?? 'GET';
        calls.push({ method, path: url.pathname });
        if (method === 'POST' && url.pathname.endsWith('/calendars'))
          return json({ id: 'new-calendar' });
        if (method === 'POST' && url.pathname.endsWith('/events')) return json({ id: 'new-event' });
        return json({ id: 'existing', status: 'confirmed' });
      }),
    );

    await gateway.ensureCalendar(user);
    await gateway.ensureCalendar({ ...user, calendarId: null });
    await gateway.eventExists(user, 'calendar-id', 'event-id');
    const event = {
      summary: '配信',
      description: 'description',
      start: '2026-07-21T10:00:00.000Z',
      end: '2026-07-21T11:00:00.000Z',
      status: 'confirmed' as const,
      extendedProperties: { private: { source: 'oshi-schedule' } },
    };
    await gateway.upsertEvent(user, 'calendar-id', null, event);
    await gateway.upsertEvent(user, 'calendar-id', 'event-id', event);
    await gateway.deleteEvent(user, 'calendar-id', 'event-id');
    await gateway.deleteCalendar(user, 'calendar-id');

    expect(calls).toEqual([
      { method: 'GET', path: '/calendar/v3/calendars/calendar-id' },
      { method: 'POST', path: '/calendar/v3/calendars' },
      { method: 'GET', path: '/calendar/v3/calendars/calendar-id/events/event-id' },
      { method: 'POST', path: '/calendar/v3/calendars/calendar-id/events' },
      { method: 'PATCH', path: '/calendar/v3/calendars/calendar-id/events/event-id' },
      { method: 'DELETE', path: '/calendar/v3/calendars/calendar-id/events/event-id' },
      { method: 'DELETE', path: '/calendar/v3/calendars/calendar-id' },
    ]);
  });
});
