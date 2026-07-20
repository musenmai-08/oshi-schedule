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
    if (this.calls === 1) throw new AppError('AUTH_DELETE_FAILED', 'failed', 502, true);
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

describe('account deletion state machine', () => {
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
      code: 'AUTH_DELETE_FAILED',
    });
    const failed = await store.findAccountDeletion(identity.subject);
    expect(failed).toMatchObject({ status: 'FAILED', userId: null });
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
});
