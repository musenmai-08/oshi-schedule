import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createContainer } from './container.js';
import { loadEnv } from './infrastructure/env.js';
import { MemoryStore } from './infrastructure/database/memory-store.js';
import { FakeCalendarGateway } from './infrastructure/google-calendar/fake-calendar-gateway.js';
import { FakeYouTubeGateway } from './infrastructure/youtube/fake-youtube-gateway.js';
import { AppError } from './domain/errors.js';

const env = loadEnv({
  NODE_ENV: 'test',
  APP_MODE: 'fake',
  ALLOWED_EMAILS: 'developer@example.com,second@example.com',
  WEB_ORIGIN: 'http://localhost:3001',
});
const store = new MemoryStore();
const container = createContainer(env, { store });
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
  const localApp = createApp(
    env,
    createContainer(env, { store: localStore, youtube, calendar }),
  );
  await request(localApp)
    .post('/api/v1/onboarding')
    .set(auth)
    .send({ providerRefreshToken: 'fake-refresh-token' });
  return { localApp, localStore, youtube, calendar };
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
    await request(app)
      .post('/api/v1/onboarding')
      .set(auth)
      .send({ providerRefreshToken: 'fake-refresh-token' });
  });
  it('serves health and rejects missing authentication', async () => {
    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
    expect(health.body.data).toEqual({ status: 'ok', service: 'oshi-schedule-api' });
    expect((await request(app).get('/api/v1/me')).status).toBe(401);
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
  it('syncs once immediately after registration and keeps retry idempotent', async () => {
    const { localApp, youtube, calendar } = await createInitialSyncApp();
    const resolved = await request(localApp)
      .post('/api/v1/channels/resolve')
      .set(auth)
      .send({ handle: '@initial' });
    const created = await request(localApp)
      .post('/api/v1/channels')
      .set(auth)
      .send({ youtubeChannelId: resolved.body.data.youtubeChannelId as string });
    expect(created.status).toBe(201);
    expect(created.body.data.initialSync.status).toBe('SUCCESS');
    expect(youtube.listCalls).toBe(1);
    expect(calendar.events.size).toBe(1);

    expect(
      (await request(localApp).post(`/api/v1/channels/${created.body.data.id}/sync`).set(auth))
        .status,
    ).toBe(202);
    expect(calendar.events.size).toBe(1);
  });
  it('keeps the subscription when initial sync fails and permits an immediate retry', async () => {
    const { localApp, calendar } = await createInitialSyncApp();
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
    expect(created.body.data.initialSync).toMatchObject({
      status: 'FAILED',
      errorCode: 'GOOGLE_EVENT_CREATE_FAILED',
    });
    const channels = await request(localApp).get('/api/v1/channels').set(auth);
    expect(channels.body.data).toHaveLength(1);
    expect(channels.body.data[0].lastSyncStatus).toBe('FAILED');

    calendar.failUpsert = false;
    expect(
      (await request(localApp).post(`/api/v1/channels/${created.body.data.id}/sync`).set(auth))
        .status,
    ).toBe(202);
    expect(calendar.events.size).toBe(1);
  });
  it('keeps registration deferred when quota is unavailable', async () => {
    const { localApp, youtube } = await createInitialSyncApp();
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
    expect(created.body.data.initialSync.status).toBe('DEFERRED');
    expect((await request(localApp).get('/api/v1/channels').set(auth)).body.data).toHaveLength(1);
  });
  it('shares a fresh channel snapshot while syncing each user calendar separately', async () => {
    const { localApp, youtube, calendar } = await createInitialSyncApp();
    const firstResolved = await request(localApp)
      .post('/api/v1/channels/resolve')
      .set(auth)
      .send({ handle: '@shared' });
    await request(localApp)
      .post('/api/v1/channels')
      .set(auth)
      .send({ youtubeChannelId: firstResolved.body.data.youtubeChannelId as string });

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

    expect(secondCreated.body.data.initialSync.status).toBe('SUCCESS');
    expect(youtube.listCalls).toBe(1);
    expect(calendar.events.size).toBe(2);
    expect(calendar.userIds.size).toBe(2);
  });
  it('pauses, resumes, syncs and deletes a subscription', async () => {
    const created = await resolveAndRegister('@flow');
    const id = created.body.data.id as string;
    expect(
      (await request(app).patch(`/api/v1/channels/${id}`).set(auth).send({ status: 'PAUSED' })).body
        .data.status,
    ).toBe('PAUSED');
    expect(
      (await request(app).patch(`/api/v1/channels/${id}`).set(auth).send({ status: 'ACTIVE' })).body
        .data.status,
    ).toBe('ACTIVE');
    expect((await request(app).post(`/api/v1/channels/${id}/sync`).set(auth)).status).toBe(202);
    expect((await request(app).post(`/api/v1/channels/${id}/sync`).set(auth)).status).toBe(429);
    expect((await request(app).delete(`/api/v1/channels/${id}`).set(auth)).status).toBe(204);
  });
  it('validates CUID path parameters and distinguishes a missing valid CUID', async () => {
    expect((await request(app).patch('/api/v1/channels/not-a-cuid').set(auth).send({ status: 'PAUSED' })).status).toBe(400);
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
    const id = created.body.data.id as string;
    await request(app)
      .post('/api/v1/onboarding')
      .set('authorization', 'Bearer test:second:second@example.com')
      .send({ providerRefreshToken: 'second-refresh-token' });
    const response = await request(app)
      .patch(`/api/v1/channels/${id}`)
      .set('authorization', 'Bearer test:second:second@example.com')
      .send({ status: 'PAUSED' });
    expect(response.status).toBe(404);
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
});
