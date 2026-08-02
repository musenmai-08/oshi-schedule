import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createContainer } from './container.js';
import { loadEnv } from './infrastructure/env.js';
import { MemoryStore } from './infrastructure/database/memory-store.js';

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
