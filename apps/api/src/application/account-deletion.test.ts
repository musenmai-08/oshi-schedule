import { describe, expect, it } from 'vitest';
import { OshiService } from './oshi-service.js';
import { SyncService } from './sync-service.js';
import { MemoryStore } from '../infrastructure/database/memory-store.js';
import { FakeYouTubeGateway } from '../infrastructure/youtube/fake-youtube-gateway.js';
import { FakeCalendarGateway } from '../infrastructure/google-calendar/fake-calendar-gateway.js';
import { AesTokenCipher } from '../infrastructure/encryption/aes-token-cipher.js';
import { AppError } from '../domain/errors.js';
import type { AppLogger, AuthAdmin } from './models.js';

const identity = { subject: 'deleting-subject', email: 'developer@example.com' };
const clock = { now: () => new Date('2026-07-20T10:00:00.000Z') };
const logger: AppLogger = { info: () => undefined, error: () => undefined };

class FailingAuthAdmin implements AuthAdmin {
  calls = 0;
  async deleteUser() {
    this.calls += 1;
    if (this.calls === 1) throw new AppError('AUTH_DELETE_TIMEOUT', 'timeout', 502, true);
  }
}

class PausingAuthAdmin implements AuthAdmin {
  entered!: () => void;
  release!: () => void;
  readonly waiting = new Promise<void>((resolve) => {
    this.entered = resolve;
  });
  private readonly paused = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  async deleteUser() {
    this.entered();
    await this.paused;
  }
}

class FencedAuthAdmin implements AuthAdmin {
  calls = 0;
  firstEntered!: () => void;
  releaseFirst!: () => void;
  readonly waiting = new Promise<void>((resolve) => (this.firstEntered = resolve));
  private readonly paused = new Promise<void>((resolve) => (this.releaseFirst = resolve));
  async deleteUser() {
    this.calls += 1;
    if (this.calls === 1) {
      this.firstEntered();
      await this.paused;
    }
  }
}

class StepFailingCalendar extends FakeCalendarGateway {
  calendarDeletes = 0;
  revokes = 0;
  constructor(private failStep: 'calendar' | 'revoke') {
    super();
  }
  override async deleteCalendar(
    user: Parameters<FakeCalendarGateway['deleteCalendar']>[0],
    id: string,
  ) {
    this.calendarDeletes += 1;
    if (this.failStep === 'calendar' && this.calendarDeletes === 1)
      throw new AppError('GOOGLE_CALENDAR_DELETE_FAILED', 'failed', 502, true);
    await super.deleteCalendar(user, id);
  }
  override async revokeAuthorization() {
    this.revokes += 1;
    if (this.failStep === 'revoke' && this.revokes === 1)
      throw new AppError('GOOGLE_REVOKE_FAILED', 'failed', 502, true);
  }
}

class ExpiringCalendar extends FakeCalendarGateway {
  revokes = 0;
  constructor(private readonly expire: () => void) {
    super();
  }
  override async deleteCalendar(
    user: Parameters<FakeCalendarGateway['deleteCalendar']>[0],
    id: string,
  ) {
    await super.deleteCalendar(user, id);
    this.expire();
  }
  override async revokeAuthorization() {
    this.revokes += 1;
  }
}

class ReauthCalendar extends FakeCalendarGateway {
  fail = true;
  override async deleteCalendar(user: Parameters<FakeCalendarGateway['deleteCalendar']>[0], id: string) {
    if (this.fail) throw new AppError('GOOGLE_REAUTH_REQUIRED', 'Reconnect', 401);
    await super.deleteCalendar(user, id);
  }
}

describe('account deletion state machine', () => {
  it('retains mapping and queue when Calendar deletion needs reconnection, then resumes', async () => {
    const store = new MemoryStore();
    const youtube = new FakeYouTubeGateway();
    const calendar = new ReauthCalendar();
    const sync = new SyncService(store, youtube, calendar, clock, logger);
    const service = new OshiService(store, youtube, calendar,
      new AesTokenCipher(`v1:${Buffer.alloc(32, 7).toString('base64')}`), clock,
      { deleteUser: async () => undefined }, sync);
    const user = await service.onboard(identity, 'refresh-token');
    const channel = await store.upsertChannel({ id: 'channel', youtubeChannelId: 'UC-deletion', title: 'channel', handle: '@deletion', thumbnailUrl: '', channelUrl: '' });
    const [broadcast] = await store.upsertBroadcasts(channel.id, [{ youtubeVideoId: 'deletion-video', title: 'old', kind: 'LIVE', status: 'COMPLETED', youtubeUrl: '', thumbnailUrl: '', scheduledStartAt: clock.now(), endAt: clock.now(), endTimeProvisional: false, actualStartAt: null, actualEndAt: clock.now() }], clock.now());
    await store.saveMapping({ userId: user.id, broadcastId: broadcast!.id, eventId: 'deletion-event', managedFieldsHash: 'hash' });
    await expect(service.deleteAccount(identity)).rejects.toMatchObject({ code: 'GOOGLE_REAUTH_REQUIRED' });
    expect(await store.getMapping(user.id, broadcast!.id)).not.toBeNull();
    expect(store.cleanupTasks).toMatchObject([{ eventId: 'deletion-event' }]);
    calendar.fail = false;
    await service.onboard(identity, 'replacement-token');
    await service.deleteAccount(identity);
    expect(await store.findUserById(user.id)).toBeNull();
  });
  it('survives an Auth deletion failure, blocks normal APIs and resumes idempotently', async () => {
    const store = new MemoryStore();
    const youtube = new FakeYouTubeGateway();
    const calendar = new FakeCalendarGateway();
    const authAdmin = new FailingAuthAdmin();
    const sync = new SyncService(store, youtube, calendar, clock, logger);
    const service = new OshiService(
      store,
      youtube,
      calendar,
      new AesTokenCipher(`v1:${Buffer.alloc(32, 3).toString('base64')}`),
      clock,
      authAdmin,
      sync,
    );
    await service.onboard(identity, 'refresh-token');

    await expect(service.deleteAccount(identity)).rejects.toMatchObject({
      code: 'AUTH_DELETE_TIMEOUT',
    });
    const failed = await store.findAccountDeletion(identity.subject);
    expect(failed).toMatchObject({
      status: 'FAILED',
      userId: null,
      lastErrorCode: 'AUTH_DELETE_TIMEOUT',
    });
    expect(failed?.userDataDeletedAt).not.toBeNull();
    await expect(service.list(identity)).rejects.toMatchObject({
      code: 'ACCOUNT_DELETION_IN_PROGRESS',
    });

    await service.deleteAccount(identity);
    await service.deleteAccount(identity);
    expect(await store.findUserBySubject(identity.subject)).toBeNull();
    expect(await store.findAccountDeletion(identity.subject)).toMatchObject({
      status: 'COMPLETED',
    });
    await expect(service.onboard(identity, 'new-token')).rejects.toMatchObject({
      code: 'ACCOUNT_DELETED',
    });
    expect(authAdmin.calls).toBe(2);
  });

  it.each(['calendar', 'revoke'] as const)('resumes after a %s step failure', async (step) => {
    const store = new MemoryStore();
    const youtube = new FakeYouTubeGateway();
    const calendar = new StepFailingCalendar(step);
    const sync = new SyncService(store, youtube, calendar, clock, logger);
    const service = new OshiService(
      store,
      youtube,
      calendar,
      new AesTokenCipher(`v1:${Buffer.alloc(32, 4).toString('base64')}`),
      clock,
      { deleteUser: async () => undefined },
      sync,
    );
    await service.onboard(identity, 'refresh-token');
    await expect(service.deleteAccount(identity)).rejects.toBeInstanceOf(AppError);
    await service.deleteAccount(identity);
    expect(await store.findAccountDeletion(identity.subject)).toMatchObject({
      status: 'COMPLETED',
    });
    expect(calendar.calendarDeletes).toBe(step === 'calendar' ? 2 : 1);
  });

  it('serializes duplicate deletion requests and leaves another user active', async () => {
    const store = new MemoryStore();
    const youtube = new FakeYouTubeGateway();
    const calendar = new FakeCalendarGateway();
    const authAdmin = new PausingAuthAdmin();
    const service = new OshiService(
      store,
      youtube,
      calendar,
      new AesTokenCipher(`v1:${Buffer.alloc(32, 5).toString('base64')}`),
      clock,
      authAdmin,
      new SyncService(store, youtube, calendar, clock, logger),
    );
    await service.onboard(identity, 'refresh-token');
    const other = { subject: 'active-subject', email: 'second@example.com' };
    await service.onboard(other, 'other-refresh-token');

    const first = service.deleteAccount(identity);
    await authAdmin.waiting;
    await expect(service.deleteAccount(identity)).rejects.toMatchObject({
      code: 'ACCOUNT_DELETION_IN_PROGRESS',
    });
    expect(await service.me(other)).toMatchObject({ subject: other.subject });
    authAdmin.release();
    await first;
  });

  it('lets a successor resume after timeout and fences the delayed first writer', async () => {
    let current = new Date('2026-07-20T10:00:00.000Z');
    const mutableClock = { now: () => current };
    const store = new MemoryStore();
    const youtube = new FakeYouTubeGateway();
    const calendar = new FakeCalendarGateway();
    const authAdmin = new FencedAuthAdmin();
    const sync = new SyncService(store, youtube, calendar, mutableClock, logger, 60_000);
    const service = new OshiService(
      store,
      youtube,
      calendar,
      new AesTokenCipher(`v1:${Buffer.alloc(32, 5).toString('base64')}`),
      mutableClock,
      authAdmin,
      sync,
      60_000,
    );
    await service.onboard(identity, 'refresh-token');

    const stale = service.deleteAccount(identity);
    await authAdmin.waiting;
    current = new Date('2026-07-20T10:01:01.000Z');
    await service.deleteAccount(identity);
    expect(await store.findAccountDeletion(identity.subject)).toMatchObject({
      status: 'COMPLETED',
    });

    authAdmin.releaseFirst();
    await expect(stale).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_LEASE_LOST' });
    expect(await store.findAccountDeletion(identity.subject)).toMatchObject({
      status: 'COMPLETED',
    });
  });

  it('stops before the next deletion step when the lease is lost after an external call', async () => {
    let current = new Date('2026-07-20T10:00:00.000Z');
    const mutableClock = { now: () => current };
    const store = new MemoryStore();
    const youtube = new FakeYouTubeGateway();
    const calendar = new ExpiringCalendar(() => {
      current = new Date('2026-07-20T10:01:01.000Z');
    });
    let authDeletes = 0;
    const service = new OshiService(
      store,
      youtube,
      calendar,
      new AesTokenCipher(`v1:${Buffer.alloc(32, 5).toString('base64')}`),
      mutableClock,
      { deleteUser: async () => void (authDeletes += 1) },
      new SyncService(store, youtube, calendar, mutableClock, logger, 60_000),
      60_000,
    );
    await service.onboard(identity, 'refresh-token');
    await expect(service.deleteAccount(identity)).rejects.toMatchObject({
      code: 'ACCOUNT_DELETION_LEASE_LOST',
    });
    expect(calendar.revokes).toBe(0);
    expect(authDeletes).toBe(0);
    expect(await store.findAccountDeletion(identity.subject)).toMatchObject({
      status: 'REQUESTED',
      calendarDeletedAt: null,
    });
  });
});
