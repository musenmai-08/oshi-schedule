import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { createContainer } from './container.js';
import { loadEnv } from './infrastructure/env.js';
import { MemoryStore } from './infrastructure/database/memory-store.js';
import { FakeCalendarGateway } from './infrastructure/google-calendar/fake-calendar-gateway.js';
import { FakeYouTubeGateway } from './infrastructure/youtube/fake-youtube-gateway.js';
import { AppError } from './domain/errors.js';
import { logger } from './infrastructure/logging/logger.js';

const env = loadEnv({
  NODE_ENV: 'test',
  APP_MODE: 'fake',
  ALLOWED_EMAILS: 'developer@example.com,second@example.com',
  WEB_ORIGIN: 'http://localhost:3001',
});
const store = new MemoryStore();
const dispatched: string[] = [];
const dispatcher = { dispatch: async (syncRunId: string) => void dispatched.push(syncRunId) };
const container = createContainer(env, { store, dispatcher });
const app = createApp(env, container);
const auth = { authorization: 'Bearer demo-token' };

class InitialSyncYouTube extends FakeYouTubeGateway {
  listCalls = 0;
  deferred = false;
  override async listUpcoming(...args: Parameters<FakeYouTubeGateway['listUpcoming']>) {
    this.listCalls += 1;
    if (this.deferred)
      throw new AppError(
        'YOUTUBE_QUOTA_DEFERRED',
        'YouTube情報の更新を次回同期まで延期しました',
        429,
        true,
        { nextRetryAt: new Date(Date.now() + 60_000).toISOString() },
      );
    return super.listUpcoming(...args);
  }
}

class InitialSyncCalendar extends FakeCalendarGateway {
  failUpsert = false;
  upserts = 0;
  readonly userIds = new Set<string>();
  override async upsertEvent(...args: Parameters<FakeCalendarGateway['upsertEvent']>) {
    this.upserts += 1;
    this.userIds.add(args[0].id);
    if (this.failUpsert)
      throw new AppError('GOOGLE_EVENT_CREATE_FAILED', '予定を作成できません', 502);
    return super.upsertEvent(...args);
  }
}

async function createInitialSyncApp() {
  const localStore = new MemoryStore();
  const youtube = new InitialSyncYouTube();
  const calendar = new InitialSyncCalendar();
  const localDispatched: string[] = [];
  const localContainer = createContainer(env, {
    store: localStore,
    youtube,
    calendar,
    dispatcher: { dispatch: async (syncRunId) => void localDispatched.push(syncRunId) },
  });
  const localApp = createApp(env, localContainer);
  await request(localApp)
    .post('/api/v1/onboarding')
    .set(auth)
    .send({ providerRefreshToken: 'fake-refresh-token' });
  return { localApp, localStore, youtube, calendar, localContainer, localDispatched };
}

async function resolveAndRegister(handle: string) {
  const resolved = await request(app).post('/api/v1/channels/resolve').set(auth).send({ handle });
  return request(app)
    .post('/api/v1/channels')
    .set(auth)
    .send({ youtubeChannelId: resolved.body.data.youtubeChannelId as string });
}

describe('API', () => {
  beforeEach(async () => {
    store.reset();
    dispatched.length = 0;
    await request(app)
      .post('/api/v1/onboarding')
      .set(auth)
      .send({ providerRefreshToken: 'fake-refresh-token' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('serves health and rejects missing authentication', async () => {
    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
    expect(health.body.data).toEqual({ status: 'ok', service: 'oshi-schedule-api' });
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    expect(health.headers).not.toHaveProperty('content-security-policy');
    expect(health.headers).not.toHaveProperty('strict-transport-security');
    expect((await request(app).get('/api/v1/me')).status).toBe(401);
  });
  it('separates liveness from database readiness without exposing errors', async () => {
    const healthyReady = await request(app).get('/ready');
    expect(healthyReady.status).toBe(200);
    expect(healthyReady.body.data).toEqual({ status: 'ready', service: 'oshi-schedule-api' });

    const unavailableApp = createApp(
      env,
      createContainer(env, {
        store: new MemoryStore(),
        resources: {
          checkReadiness: async () => {
            throw new Error('database-url-must-not-be-returned');
          },
          disconnect: async () => undefined,
        },
      }),
    );
    const readiness = await request(unavailableApp).get('/ready');
    expect(readiness.status).toBe(503);
    expect(readiness.body.data).toEqual({
      status: 'not_ready',
      service: 'oshi-schedule-api',
    });
    expect(JSON.stringify(readiness.body)).not.toContain('database-url-must-not-be-returned');
    expect((await request(unavailableApp).get('/health')).status).toBe(200);
  });
  it('trusts only the configured number of proxy hops', () => {
    expect(app.get('trust proxy')).toBe(0);
    const oneHopApp = createApp(
      loadEnv({
        NODE_ENV: 'test',
        APP_MODE: 'fake',
        ALLOWED_EMAILS: 'developer@example.com',
        WEB_ORIGIN: 'http://localhost:3001',
        TRUST_PROXY_HOPS: '1',
      }),
      container,
    );
    expect(oneHopApp.get('trust proxy')).toBe(1);
    const trust = oneHopApp.get('trust proxy fn') as (address: string, index: number) => boolean;
    expect(trust('10.0.0.1', 0)).toBe(true);
    expect(trust('10.0.0.2', 1)).toBe(false);
  });
  it('does not let a client-controlled leftmost forwarded address evade rate-limit identity', async () => {
    const oneHopApp = createApp(
      loadEnv({
        NODE_ENV: 'test',
        APP_MODE: 'fake',
        ALLOWED_EMAILS: 'developer@example.com',
        WEB_ORIGIN: 'http://localhost:3001',
        TRUST_PROXY_HOPS: '1',
      }),
      container,
    );
    const first = await request(oneHopApp)
      .get('/api/v1/me')
      .set(auth)
      .set('x-forwarded-for', '192.0.2.1, 198.51.100.10');
    const second = await request(oneHopApp)
      .get('/api/v1/me')
      .set(auth)
      .set('x-forwarded-for', '192.0.2.2, 198.51.100.10');
    expect(Number(second.headers['ratelimit-remaining'])).toBe(
      Number(first.headers['ratelimit-remaining']) - 1,
    );
  });
  it('rejects a non invited email', async () => {
    const response = await request(app)
      .get('/api/v1/me')
      .set('authorization', 'Bearer test:outsider:outsider@example.com');
    expect(response.status).toBe(403);
  });
  it('registers, rejects duplicate and enforces the three-channel limit', async () => {
    expect((await resolveAndRegister('@first')).status).toBe(201);
    expect((await resolveAndRegister('@first')).status).toBe(409);
    expect((await resolveAndRegister('@second')).status).toBe(201);
    expect((await resolveAndRegister('@third')).status).toBe(201);
    expect((await resolveAndRegister('@fourth')).status).toBe(422);
  });
  it('queues initial sync without waiting and keeps duplicate delivery idempotent', async () => {
    const { localApp, youtube, calendar, localContainer, localDispatched } =
      await createInitialSyncApp();
    const resolved = await request(localApp)
      .post('/api/v1/channels/resolve')
      .set(auth)
      .send({ handle: '@initial' });
    const created = await request(localApp)
      .post('/api/v1/channels')
      .set(auth)
      .send({ youtubeChannelId: resolved.body.data.youtubeChannelId as string });
    expect(created.status).toBe(201);
    expect(created.body.data.sync.status).toBe('QUEUED');
    expect(localDispatched).toEqual([created.body.data.sync.id]);
    expect(youtube.listCalls).toBe(0);
    expect(calendar.events.size).toBe(0);

    const queued = await request(localApp)
      .get(`/api/v1/sync-runs/${created.body.data.sync.id}`)
      .set(auth);
    expect(queued.body.data.status).toBe('QUEUED');
    await localContainer.service.sync.runTargeted(created.body.data.sync.id);
    expect(youtube.listCalls).toBe(1);
    expect(calendar.events.size).toBe(1);
    expect(
      (await request(localApp).get(`/api/v1/sync-runs/${created.body.data.sync.id}`).set(auth)).body
        .data.status,
    ).toBe('SUCCESS');
    expect((await localContainer.service.sync.runTargeted(created.body.data.sync.id)).status).toBe(
      'SKIPPED',
    );
    expect(calendar.events.size).toBe(1);
  });
  it('records dispatch failure without losing the created subscription', async () => {
    const localStore = new MemoryStore();
    const localContainer = createContainer(env, {
      store: localStore,
      dispatcher: { dispatch: async () => Promise.reject(new Error('queue unavailable')) },
    });
    const localApp = createApp(env, localContainer);
    await request(localApp)
      .post('/api/v1/onboarding')
      .set(auth)
      .send({ providerRefreshToken: 'fake-refresh-token' });
    const resolved = await request(localApp)
      .post('/api/v1/channels/resolve')
      .set(auth)
      .send({ handle: '@dispatch-failure' });
    const created = await request(localApp)
      .post('/api/v1/channels')
      .set(auth)
      .send({ youtubeChannelId: resolved.body.data.youtubeChannelId as string });
    expect(created.status).toBe(201);
    expect(created.body.data.sync).toMatchObject({
      status: 'FAILED',
      errorCode: 'SYNC_DISPATCH_FAILED',
    });
    const channels = (await request(localApp).get('/api/v1/channels').set(auth)).body.data;
    expect(channels).toHaveLength(1);
    expect(channels[0].lastSyncStatus).toBe('FAILED');
    expect(
      (await request(localApp).get(`/api/v1/sync-runs/${created.body.data.sync.id}`).set(auth)).body
        .data,
    ).toMatchObject({ status: 'FAILED', error: { code: 'SYNC_DISPATCH_FAILED' } });
  });
  it('keeps the subscription when initial sync fails and permits an immediate retry', async () => {
    const { localApp, calendar, localContainer } = await createInitialSyncApp();
    calendar.failUpsert = true;
    const resolved = await request(localApp)
      .post('/api/v1/channels/resolve')
      .set(auth)
      .send({ handle: '@failure' });
    const created = await request(localApp)
      .post('/api/v1/channels')
      .set(auth)
      .send({ youtubeChannelId: resolved.body.data.youtubeChannelId as string });
    expect(created.status).toBe(201);
    await expect(
      localContainer.service.sync.runTargeted(created.body.data.sync.id),
    ).rejects.toThrow('予定を作成できません');
    const channels = await request(localApp).get('/api/v1/channels').set(auth);
    expect(channels.body.data).toHaveLength(1);
    expect(channels.body.data[0].lastSyncStatus).toBe('FAILED');

    calendar.failUpsert = false;
    const retry = await request(localApp)
      .post(`/api/v1/channels/${created.body.data.subscription.id}/sync`)
      .set(auth);
    expect(retry.status).toBe(202);
    await localContainer.service.sync.runTargeted(retry.body.data.id);
    expect(calendar.events.size).toBe(1);
  });
  it('keeps registration deferred when quota is unavailable', async () => {
    const { localApp, youtube, localContainer } = await createInitialSyncApp();
    youtube.deferred = true;
    const resolved = await request(localApp)
      .post('/api/v1/channels/resolve')
      .set(auth)
      .send({ handle: '@deferred' });
    const created = await request(localApp)
      .post('/api/v1/channels')
      .set(auth)
      .send({ youtubeChannelId: resolved.body.data.youtubeChannelId as string });
    expect(created.status).toBe(201);
    const result = await localContainer.service.sync.runTargeted(created.body.data.sync.id);
    expect(result.status).toBe('DEFERRED');
    expect((await request(localApp).get('/api/v1/channels').set(auth)).body.data).toHaveLength(1);
  });
  it('shares a fresh channel snapshot while syncing each user calendar separately', async () => {
    const { localApp, youtube, calendar, localContainer } = await createInitialSyncApp();
    const firstResolved = await request(localApp)
      .post('/api/v1/channels/resolve')
      .set(auth)
      .send({ handle: '@shared' });
    const firstCreated = await request(localApp)
      .post('/api/v1/channels')
      .set(auth)
      .send({ youtubeChannelId: firstResolved.body.data.youtubeChannelId as string });
    await localContainer.service.sync.runTargeted(firstCreated.body.data.sync.id);

    const secondAuth = { authorization: 'Bearer test:second:second@example.com' };
    await request(localApp)
      .post('/api/v1/onboarding')
      .set(secondAuth)
      .send({ providerRefreshToken: 'second-refresh-token' });
    const secondResolved = await request(localApp)
      .post('/api/v1/channels/resolve')
      .set(secondAuth)
      .send({ handle: '@shared' });
    const secondCreated = await request(localApp)
      .post('/api/v1/channels')
      .set(secondAuth)
      .send({ youtubeChannelId: secondResolved.body.data.youtubeChannelId as string });

    await localContainer.service.sync.runTargeted(secondCreated.body.data.sync.id);
    expect(secondCreated.body.data.sync.status).toBe('QUEUED');
    expect(youtube.listCalls).toBe(1);
    expect(calendar.events.size).toBe(2);
    expect(calendar.userIds.size).toBe(2);
  });
  it('pauses, resumes, syncs and deletes a subscription', async () => {
    const created = await resolveAndRegister('@flow');
    const id = created.body.data.subscription.id as string;
    expect(
      (await request(app).patch(`/api/v1/channels/${id}`).set(auth).send({ status: 'PAUSED' })).body
        .data.status,
    ).toBe('PAUSED');
    expect(
      (await request(app).patch(`/api/v1/channels/${id}`).set(auth).send({ status: 'ACTIVE' })).body
        .data.status,
    ).toBe('ACTIVE');
    const first = await request(app).post(`/api/v1/channels/${id}/sync`).set(auth);
    expect(first.status).toBe(202);
    const duplicate = await request(app).post(`/api/v1/channels/${id}/sync`).set(auth);
    expect(duplicate.status).toBe(202);
    expect(duplicate.body.data.id).toBe(first.body.data.id);
    expect((await request(app).delete(`/api/v1/channels/${id}`).set(auth)).status).toBe(204);
  });
  it('validates CUID path parameters and distinguishes a missing valid CUID', async () => {
    expect(
      (await request(app).patch('/api/v1/channels/not-a-cuid').set(auth).send({ status: 'PAUSED' }))
        .status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .patch('/api/v1/channels/cm0wz73bk0000qzrmn831i7rn')
          .set(auth)
          .send({ status: 'PAUSED' })
      ).status,
    ).toBe(404);
  });
  it('does not expose another user subscription', async () => {
    const created = await resolveAndRegister('@private');
    const id = created.body.data.subscription.id as string;
    await request(app)
      .post('/api/v1/onboarding')
      .set('authorization', 'Bearer test:second:second@example.com')
      .send({ providerRefreshToken: 'second-refresh-token' });
    const response = await request(app)
      .patch(`/api/v1/channels/${id}`)
      .set('authorization', 'Bearer test:second:second@example.com')
      .send({ status: 'PAUSED' });
    expect(response.status).toBe(404);
    const syncRunId = created.body.data.sync.id as string;
    expect(
      (
        await request(app)
          .get(`/api/v1/sync-runs/${syncRunId}`)
          .set('authorization', 'Bearer test:second:second@example.com')
      ).status,
    ).toBe(404);
  });
  it('requires confirmation and deletes an account', async () => {
    expect(
      (await request(app).delete('/api/v1/account').set(auth).send({ confirmation: 'wrong' }))
        .status,
    ).toBe(400);
    expect(
      (await request(app).delete('/api/v1/account').set(auth).send({ confirmation: 'DELETE' }))
        .status,
    ).toBe(204);
  });

  it('returns common JSON errors for malformed, empty and oversized JSON bodies', async () => {
    const malformed = await request(app)
      .post('/api/v1/channels/resolve')
      .set(auth)
      .set('content-type', 'application/json')
      .send('{"token":"must-not-be-logged"');
    expect(malformed.status).toBe(400);
    expect(malformed.type).toBe('application/json');
    expect(malformed.body).toMatchObject({
      error: { code: 'INVALID_JSON', message: 'JSONの形式が正しくありません' },
    });
    expect(JSON.stringify(malformed.body)).not.toContain('token');
    expect(JSON.stringify(malformed.body)).not.toContain('stack');
    expect(malformed.text).not.toContain('<!DOCTYPE');

    const empty = await request(app)
      .post('/api/v1/channels/resolve')
      .set(auth)
      .set('content-type', 'application/json');
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('VALIDATION_ERROR');

    const oversized = await request(app)
      .post('/api/v1/channels/resolve')
      .set(auth)
      .send({ handle: `@${'x'.repeat(33 * 1024)}` });
    expect(oversized.status).toBe(413);
    expect(oversized.type).toBe('application/json');
    expect(oversized.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('returns a common JSON 404 for an undefined API route', async () => {
    const response = await request(app).get('/api/v1/not-defined').set(auth);
    expect(response.status).toBe(404);
    expect(response.type).toBe('application/json');
    expect(response.body).toMatchObject({
      error: { code: 'NOT_FOUND', message: '指定されたAPIは存在しません' },
    });
    expect(response.text).not.toContain('<!DOCTYPE');
    expect(response.text).not.toContain('stack');
  });

  it('logs expected client errors below error level and unexpected failures at error', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    await request(app)
      .post('/api/v1/channels/resolve')
      .set(auth)
      .set('content-type', 'application/json')
      .send('{"authorization":"Bearer must-not-be-logged"');
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'INVALID_JSON', status: 400 }),
      'request rejected',
    );
    expect(error).not.toHaveBeenCalled();
    expect(JSON.stringify(info.mock.calls)).not.toContain('must-not-be-logged');

    await request(app).get('/api/v1/not-defined').set(auth);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'NOT_FOUND', status: 404 }),
      'request rejected',
    );
    expect(error).not.toHaveBeenCalled();

    await request(app).post('/api/v1/channels/resolve').set(auth).send({ handle: '@first' });
    await request(app).post('/api/v1/channels').set(auth).send({ youtubeChannelId: 'missing' });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'CHANNEL_NOT_RESOLVED', status: 409 }),
      'request rejected',
    );

    vi.spyOn(container.service, 'me').mockRejectedValueOnce(new Error('database details'));
    const internal = await request(app).get('/api/v1/me').set(auth);
    expect(internal.status).toBe(500);
    expect(internal.body.error).toEqual({ code: 'INTERNAL_ERROR', message: '処理に失敗しました' });
    expect(internal.text).not.toContain('database details');
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'INTERNAL_ERROR', status: 500 }),
      'request failed',
    );
  });
});
