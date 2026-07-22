import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createApp } from './app.js';
import { createContainer } from './container.js';
import { loadEnv } from './infrastructure/env.js';
import { PrismaStore } from './infrastructure/database/prisma-store.js';
import { AppError } from './domain/errors.js';
import type { AuthAdmin } from './application/models.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const prisma = new PrismaClient(databaseUrl ? { datasourceUrl: databaseUrl } : undefined);
const store = new PrismaStore(prisma);
class ControllableAuthAdmin implements AuthAdmin {
  fail = false;
  async deleteUser() {
    if (this.fail) throw new AppError('AUTH_DELETE_FAILED', 'failed', 502, true);
  }
}
const authAdmin = new ControllableAuthAdmin();
const env = loadEnv({
  NODE_ENV: 'test',
  APP_MODE: 'fake',
  ALLOWED_EMAILS: 'developer@example.com,second@example.com',
  WEB_ORIGIN: 'http://localhost:3000',
});
const app = createApp(env, createContainer(env, { store, authAdmin }));
const ownerAuth = { authorization: 'Bearer test:prisma-owner:developer@example.com' };
const otherAuth = { authorization: 'Bearer test:prisma-other:second@example.com' };

async function clean() {
  await prisma.syncLease.deleteMany({
    where: { key: { startsWith: 'integration:' } },
  });
  await prisma.accountDeletionRequest.deleteMany({
    where: { supabaseUserId: { in: ['prisma-owner', 'prisma-other'] } },
  });
  await prisma.youTubeQuotaUsage.deleteMany({
    where: { quotaDate: { startsWith: '2099-' } },
  });
  await prisma.user.deleteMany({
    where: { supabaseUserId: { in: ['prisma-owner', 'prisma-other'] } },
  });
  await prisma.scheduledBroadcast.deleteMany({
    where: { channel: { youtubeChannelId: { startsWith: 'UCprisma' } } },
  });
  await prisma.youTubeChannel.deleteMany({
    where: { youtubeChannelId: { startsWith: 'UCprisma' } },
  });
}

describe.runIf(Boolean(databaseUrl))('API with Prisma/MySQL IDs and constraints', () => {
  beforeEach(async () => {
    authAdmin.fail = false;
    await clean();
    for (const [auth, token] of [
      [ownerAuth, 'owner-refresh'],
      [otherAuth, 'other-refresh'],
    ] as const)
      await request(app).post('/api/v1/onboarding').set(auth).send({ providerRefreshToken: token });
  });
  afterAll(async () => {
    await clean();
    await prisma.$disconnect();
  });

  async function register(handle: string) {
    const resolved = await request(app)
      .post('/api/v1/channels/resolve')
      .set(ownerAuth)
      .send({ handle });
    const youtubeChannelId = `UCprisma${resolved.body.data.youtubeChannelId as string}`;
    await prisma.youTubeChannel.update({
      where: { id: resolved.body.data.id as string },
      data: { youtubeChannelId },
    });
    return request(app).post('/api/v1/channels').set(ownerAuth).send({ youtubeChannelId });
  }

  it('accepts an actual Prisma CUID for pause, resume, sync and delete', async () => {
    const created = await register('@prismaflow');
    const id = created.body.data.id as string;
    expect(id).toMatch(/^c/);
    expect(
      (await request(app).patch(`/api/v1/channels/${id}`).set(ownerAuth).send({ status: 'PAUSED' }))
        .status,
    ).toBe(200);
    expect(
      (await request(app).patch(`/api/v1/channels/${id}`).set(ownerAuth).send({ status: 'ACTIVE' }))
        .status,
    ).toBe(200);
    expect((await request(app).post(`/api/v1/channels/${id}/sync`).set(ownerAuth)).status).toBe(
      202,
    );
    expect(
      (await request(app).patch(`/api/v1/channels/${id}`).set(otherAuth).send({ status: 'PAUSED' }))
        .status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .patch('/api/v1/channels/cm0wz73bk0000qzrmn831i7rn')
          .set(ownerAuth)
          .send({ status: 'PAUSED' })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .patch('/api/v1/channels/not-a-cuid')
          .set(ownerAuth)
          .send({ status: 'PAUSED' })
      ).status,
    ).toBe(400);
    expect((await request(app).delete(`/api/v1/channels/${id}`).set(ownerAuth)).status).toBe(204);
  });

  it('keeps the three-channel limit under concurrent distinct registrations', async () => {
    await register('@prismaone');
    await register('@prismatwo');
    const handles = ['@prismathree', '@prismafour'];
    const ids: string[] = [];
    for (const handle of handles) {
      const resolved = await request(app)
        .post('/api/v1/channels/resolve')
        .set(ownerAuth)
        .send({ handle });
      const youtubeChannelId = `UCprisma${resolved.body.data.youtubeChannelId as string}`;
      await prisma.youTubeChannel.update({
        where: { id: resolved.body.data.id as string },
        data: { youtubeChannelId },
      });
      ids.push(youtubeChannelId);
    }
    const responses = await Promise.all(
      ids.map((youtubeChannelId) =>
        request(app).post('/api/v1/channels').set(ownerAuth).send({ youtubeChannelId }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([201, 422]);
    const user = await prisma.user.findUnique({ where: { supabaseUserId: 'prisma-owner' } });
    expect(await prisma.userChannelSubscription.count({ where: { userId: user!.id } })).toBe(3);
  });

  it('persists an account deletion tombstone across local data and Auth deletion failure', async () => {
    authAdmin.fail = true;
    expect(
      (await request(app).delete('/api/v1/account').set(ownerAuth).send({ confirmation: 'DELETE' }))
        .status,
    ).toBe(502);
    expect(
      await prisma.accountDeletionRequest.findUnique({ where: { supabaseUserId: 'prisma-owner' } }),
    ).toMatchObject({ status: 'FAILED', userId: null });
    expect((await request(app).get('/api/v1/channels').set(ownerAuth)).status).toBe(410);
    expect((await request(app).get('/api/v1/me').set(otherAuth)).status).toBe(200);

    authAdmin.fail = false;
    expect(
      (await request(app).delete('/api/v1/account').set(ownerAuth).send({ confirmation: 'DELETE' }))
        .status,
    ).toBe(204);
    expect((await request(app).get('/api/v1/me').set(ownerAuth)).status).toBe(410);
    expect(await prisma.user.findUnique({ where: { supabaseUserId: 'prisma-owner' } })).toBeNull();
    expect(
      await prisma.accountDeletionRequest.findUnique({ where: { supabaseUserId: 'prisma-owner' } }),
    ).toMatchObject({ status: 'COMPLETED' });
  });

  it('enforces and renews a cross-process lease in MySQL', async () => {
    const key = 'integration:shared-sync';
    const now = new Date('2026-07-20T10:00:00Z');
    const results = await Promise.all([
      store.acquireSyncLease(key, 'owner-a', now, 900_000),
      store.acquireSyncLease(key, 'owner-b', now, 900_000),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const lease = results.find((result) => result)!;
    expect(
      await store.renewSyncLease(
        { ...lease, ownerToken: lease.ownerToken === 'owner-a' ? 'owner-b' : 'owner-a' },
        now,
        900_000,
      ),
    ).toBe(false);
    expect(await store.renewSyncLease(lease, now, 900_000)).toBe(true);

    await prisma.syncLease.update({
      where: { key },
      data: { expiresAt: new Date('2000-01-01T00:00:00Z') },
    });
    const successor = await store.acquireSyncLease(key, 'owner-successor', now, 900_000);
    expect(successor?.version).toBe(lease.version + 1);
    expect(await store.renewSyncLease(lease, now, 900_000)).toBe(false);
    expect(await store.releaseSyncLease(lease)).toBe(false);
    expect(await store.releaseSyncLease(successor!)).toBe(true);
  });

  it('atomically reserves YouTube quota without exceeding the budget', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 30 }, () =>
        store.reserveYouTubeQuota('2099-07-20', 'GENERAL', 1, 10, 0, 'SCHEDULED'),
      ),
    );
    expect(attempts.filter((result) => result.granted)).toHaveLength(10);
    const usage = await prisma.youTubeQuotaUsage.findUnique({
      where: { quotaDate_bucket: { quotaDate: '2099-07-20', bucket: 'GENERAL' } },
    });
    expect(usage).toMatchObject({ unitsUsed: 0, unitsReserved: 10 });
    await Promise.all(
      Array.from({ length: 10 }, () => store.consumeYouTubeQuota('2099-07-20', 'GENERAL', 1)),
    );
    expect(
      await prisma.youTubeQuotaUsage.findUnique({
        where: { quotaDate_bucket: { quotaDate: '2099-07-20', bucket: 'GENERAL' } },
      }),
    ).toMatchObject({ unitsUsed: 10, unitsReserved: 0 });
  });

  it('atomically fences account deletion step updates in MySQL', async () => {
    const user = await store.findUserBySubject('prisma-owner');
    const deletion = await store.beginAccountDeletion(user!);
    const key = 'integration:fenced-account-deletion';
    const first = (await store.acquireSyncLease(key, 'old-owner', new Date(), 900_000))!;
    await prisma.syncLease.update({
      where: { key },
      data: { expiresAt: new Date('2000-01-01T00:00:00Z') },
    });
    const successor = (await store.acquireSyncLease(key, 'new-owner', new Date(), 900_000))!;
    const at = new Date('2026-07-20T10:00:00Z');
    expect(await store.markAccountDeletionStep(deletion.id, 'CALENDAR_DELETED', at, first)).toBe(
      false,
    );
    expect(
      await store.markAccountDeletionStep(deletion.id, 'CALENDAR_DELETED', at, successor),
    ).toBe(true);
    expect(await store.findAccountDeletion('prisma-owner')).toMatchObject({
      status: 'CALENDAR_DELETED',
    });
    await store.releaseSyncLease(successor);
  });
});
