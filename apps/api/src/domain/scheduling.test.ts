import { describe, expect, it } from 'vitest';
import { buildCalendarEvent, calculateEndAt, managedFieldsHash } from './scheduling.js';

describe('scheduling', () => {
  const start = new Date('2026-07-20T10:00:00.000Z');
  it('uses one hour provisional end for live', () => {
    expect(calculateEndAt('LIVE', start)).toEqual({
      endAt: new Date('2026-07-20T11:00:00.000Z'),
      provisional: true,
    });
  });
  it('uses 30 minutes provisional end for premiere', () => {
    expect(calculateEndAt('PREMIERE', start).endAt.toISOString()).toBe('2026-07-20T10:30:00.000Z');
  });
  it('builds a stable managed event', () => {
    const event = buildCalendarEvent(
      {
        youtubeVideoId: 'v1',
        title: '配信',
        kind: 'LIVE',
        status: 'UPCOMING',
        youtubeUrl: 'https://youtu.be/v1',
        thumbnailUrl: 'https://i.ytimg.com/v1.jpg',
        scheduledStartAt: start,
        endAt: new Date('2026-07-20T11:00:00Z'),
        endTimeProvisional: true,
        actualStartAt: null,
        actualEndAt: null,
      },
      '推し',
    );
    expect(event.summary).toBe('【YouTube Live】配信');
    expect(managedFieldsHash(event)).toHaveLength(64);
  });
});
