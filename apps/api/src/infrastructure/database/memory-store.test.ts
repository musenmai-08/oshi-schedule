import { describe, expect, it } from 'vitest';
import { MemoryStore } from './memory-store.js';
import type { NormalizedBroadcast } from '../../domain/scheduling.js';

describe('MemoryStore broadcast change tracking', () => {
  it('does not advance sourceUpdatedAt when the observed payload is unchanged', async () => {
    const store = new MemoryStore();
    const channel = await store.upsertChannel({
      id: 'external',
      youtubeChannelId: 'UC-change',
      title: 'channel',
      handle: '@change',
      thumbnailUrl: '',
      channelUrl: '',
    });
    const item: NormalizedBroadcast = {
      youtubeVideoId: 'video',
      title: 'title',
      kind: 'UNKNOWN',
      status: 'UPCOMING',
      youtubeUrl: 'https://youtube.example/video',
      thumbnailUrl: '',
      scheduledStartAt: new Date('2026-07-21T10:00:00Z'),
      endAt: new Date('2026-07-21T11:00:00Z'),
      endTimeProvisional: true,
      actualStartAt: null,
      actualEndAt: null,
    };
    const first = new Date('2026-07-20T10:00:00Z');
    const second = new Date('2026-07-20T11:00:00Z');
    await store.upsertBroadcasts(channel.id, [item], first);
    await store.upsertBroadcasts(channel.id, [item], second);
    expect(
      (await store.listBroadcastsForSync(channel.id, first, null))[0]?.sourceUpdatedAt,
    ).toEqual(first);
  });
});
