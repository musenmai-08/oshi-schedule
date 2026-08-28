import { describe, expect, it } from 'vitest';
import { OshiService } from './oshi-service.js';
import { SyncService } from './sync-service.js';
import { MemoryStore } from '../infrastructure/database/memory-store.js';
import { FakeYouTubeGateway } from '../infrastructure/youtube/fake-youtube-gateway.js';
import { FakeCalendarGateway } from '../infrastructure/google-calendar/fake-calendar-gateway.js';
import { AesTokenCipher } from '../infrastructure/encryption/aes-token-cipher.js';
import { AppError } from '../domain/errors.js';
import type { AppLogger, UserRecord } from './models.js';
import type { CalendarEventInput } from '../domain/scheduling.js';

const now = new Date('2026-07-20T10:00:00.000Z');
const logger: AppLogger = { info: () => undefined, error: () => undefined };
const event: CalendarEventInput = {
  summary: 'managed',
  description: 'managed',
  start: now.toISOString(),
  end: now.toISOString(),
  status: 'confirmed',
  extendedProperties: { private: { managedBy: 'oshi-schedule' } },
};

class PartiallyFailingCalendar extends FakeCalendarGateway {
  failed = false;
  failEventId = '';
  override async deleteEvent(user: UserRecord, calendarId: string, eventId: string) {
    if (eventId === this.failEventId && !this.failed) {
      this.failed = true;
      throw new AppError('GOOGLE_EVENT_DELETE_FAILED', 'failed', 502, true);
    }
    await super.deleteEvent(user, calendarId, eventId);
  }
}

describe('channel removal', () => {
  it('deletes only this user future events and resumes after a partial failure', async () => {
    const store = new MemoryStore();
    const youtube = new FakeYouTubeGateway();
    const calendar = new PartiallyFailingCalendar();
    const clock = { now: () => now };
    const sync = new SyncService(store, youtube, calendar, clock, logger);
    const service = new OshiService(
      store,
      youtube,
      calendar,
      new AesTokenCipher(`v1:${Buffer.alloc(32, 5).toString('base64')}`),
      clock,
      { deleteUser: async () => undefined },
      sync,
    );
    const identity = { subject: 'owner', email: 'developer@example.com' };
    const user = await store.ensureUser(identity);
    await store.completeOnboarding(
      user.id,
      'encrypted',
      'v1',
      'owner-calendar',
      'openid email profile https://www.googleapis.com/auth/calendar.app.created',
    );
    const other = await store.ensureUser({ subject: 'other', email: 'second@example.com' });
    const channel = await store.upsertChannel({
      id: 'external-channel',
      youtubeChannelId: 'UC-removal',
      title: 'shared',
      handle: '@shared',
      thumbnailUrl: '',
      channelUrl: '',
    });
    const subscription = await store.createSubscriptionWithinLimit(user.id, channel.id, 3);
    const broadcasts = await store.upsertBroadcasts(
      channel.id,
      [
        {
          youtubeVideoId: 'past',
          title: 'past',
          kind: 'LIVE',
          status: 'COMPLETED',
          youtubeUrl: '',
          thumbnailUrl: '',
          scheduledStartAt: new Date('2026-07-19T10:00:00Z'),
          endAt: new Date('2026-07-19T11:00:00Z'),
          endTimeProvisional: false,
          actualStartAt: null,
          actualEndAt: new Date('2026-07-19T11:00:00Z'),
        },
        ...['future-1', 'future-2'].map((id, index) => ({
          youtubeVideoId: id,
          title: id,
          kind: 'LIVE' as const,
          status: 'UPCOMING' as const,
          youtubeUrl: '',
          thumbnailUrl: '',
          scheduledStartAt: new Date(now.getTime() + (index + 1) * 3_600_000),
          endAt: new Date(now.getTime() + (index + 2) * 3_600_000),
          endTimeProvisional: true,
          actualStartAt: null,
          actualEndAt: null,
        })),
      ],
      now,
    );
    for (const broadcast of broadcasts) {
      const eventId = `owner-${broadcast.youtubeVideoId}`;
      calendar.events.set(eventId, event);
      await store.saveMapping({
        userId: user.id,
        broadcastId: broadcast.id,
        eventId,
        managedFieldsHash: 'hash',
      });
    }
    const otherEventId = 'other-future';
    calendar.events.set(otherEventId, event);
    await store.saveMapping({
      userId: other.id,
      broadcastId: broadcasts[1]!.id,
      eventId: otherEventId,
      managedFieldsHash: 'hash',
    });
    calendar.events.delete('owner-future-1');
    calendar.failEventId = 'owner-future-2';

    await expect(service.remove(identity, subscription.id)).rejects.toMatchObject({
      code: 'GOOGLE_EVENT_DELETE_FAILED',
    });
    expect(await store.getSubscription(user.id, subscription.id)).not.toBeNull();
    await service.remove(identity, subscription.id);

    expect(await store.getSubscription(user.id, subscription.id)).toBeNull();
    expect(calendar.events.has('owner-past')).toBe(true);
    expect(calendar.events.has('owner-future-1')).toBe(false);
    expect(calendar.events.has('owner-future-2')).toBe(false);
    expect(calendar.events.has(otherEventId)).toBe(true);
    expect(await store.findChannelByYoutubeId(channel.youtubeChannelId)).not.toBeNull();
  });
});
