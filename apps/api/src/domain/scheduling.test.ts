import { describe, expect, it } from 'vitest';
import {
  buildCalendarEvent,
  calculateEndAt,
  managedFieldsHash,
  shouldSyncCalendarEvent,
  type NormalizedBroadcast,
} from './scheduling.js';

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

  it.each([
    ['future scheduled without mapping', { status: 'UPCOMING', scheduledStartAt: new Date('2026-07-21T00:00:00Z') }, false, true],
    ['live without mapping', { status: 'LIVE', actualStartAt: new Date('2026-07-20T09:00:00Z'), endAt: new Date('2026-07-20T09:30:00Z'), endTimeProvisional: true }, false, true],
    ['completed without mapping', { status: 'COMPLETED' }, false, false],
    ['completed with mapping', { status: 'COMPLETED' }, true, true],
    ['unavailable without mapping', { status: 'UNAVAILABLE' }, false, false],
    ['unavailable with mapping', { status: 'UNAVAILABLE' }, true, true],
    ['past unknown without mapping', { status: 'UNKNOWN', scheduledStartAt: new Date('2026-07-19T00:00:00Z') }, false, false],
    ['future unknown without mapping', { status: 'UNKNOWN', scheduledStartAt: new Date('2026-07-21T00:00:00Z') }, false, false],
    ['confirmed actual end without mapping', { status: 'LIVE', actualEndAt: new Date('2026-07-20T09:30:00Z') }, false, false],
  ] as const)('%s', (_name, overrides, hasMapping, expected) => {
    const item: NormalizedBroadcast = Object.assign({
      youtubeVideoId: 'policy',
      title: 'policy',
      kind: 'UNKNOWN',
      status: 'UPCOMING',
      youtubeUrl: 'https://youtube.example/policy',
      thumbnailUrl: '',
      scheduledStartAt: new Date('2026-07-20T08:00:00Z'),
      endAt: new Date('2026-07-20T09:00:00Z'),
      endTimeProvisional: true,
      actualStartAt: null,
      actualEndAt: null,
    } satisfies NormalizedBroadcast, overrides);
    expect(shouldSyncCalendarEvent(item, hasMapping, new Date('2026-07-20T10:00:00Z'))).toBe(
      expected,
    );
  });
});
