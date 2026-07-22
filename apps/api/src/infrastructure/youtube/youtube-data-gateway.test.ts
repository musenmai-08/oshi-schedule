import { afterEach, describe, expect, it, vi } from 'vitest';
import { YouTubeDataGateway } from './youtube-data-gateway.js';
import type { ChannelRecord } from '../../application/models.js';
import { MemoryStore } from '../database/memory-store.js';
import { nextQuotaResetAt, quotaDateAt, YOUTUBE_QUOTA_COSTS } from './youtube-quota.js';

const channel: ChannelRecord = {
  id: 'cm0wz73bk0000qzrmn831i7rn',
  youtubeChannelId: 'UC-test',
  title: 'channel',
  handle: '@channel',
  thumbnailUrl: '',
  channelUrl: '',
  lastFetchedAt: null,
  fetchStartedAt: null,
  fetchCompletedAt: null,
  lastFetchSucceededAt: null,
  snapshotVersion: 0,
  lastFetchStatus: 'NEVER',
  nextFetchAt: null,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => vi.unstubAllGlobals());

describe('YouTubeDataGateway', () => {
  const quotaConfig = {
    dailyBudget: 8_000,
    dailySearchBudget: 80,
    scheduledReserve: 432,
    scheduledSearchReserve: 72,
    timeZone: 'America/Los_Angeles',
    maxSearchPages: 1,
    maxAttempts: 3,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 5_000,
  };
  it('does not infer premiere from duration and follows a completed broadcast by video ID', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ items: [{ id: { videoId: 'video-1' } }] }))
      .mockResolvedValueOnce(
        json({
          items: [
            {
              id: 'video-1',
              snippet: { title: 'scheduled', liveBroadcastContent: 'upcoming' },
              contentDetails: { duration: 'PT30M' },
              liveStreamingDetails: { scheduledStartTime: '2026-07-21T10:00:00Z' },
              status: { uploadStatus: 'processed' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        json({
          items: [
            {
              id: 'video-1',
              snippet: { title: 'completed', liveBroadcastContent: 'none' },
              contentDetails: { duration: 'PT30M' },
              liveStreamingDetails: {
                scheduledStartTime: '2026-07-21T10:00:00Z',
                actualStartTime: '2026-07-21T10:02:00Z',
                actualEndTime: '2026-07-21T10:42:00Z',
              },
              status: { uploadStatus: 'processed' },
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const gateway = new YouTubeDataGateway('key');

    const upcoming = await gateway.listUpcoming(
      channel,
      new Date('2026-07-20T00:00:00Z'),
      new Date('2026-08-20T00:00:00Z'),
    );
    expect(upcoming[0]).toMatchObject({ kind: 'UNKNOWN', status: 'UPCOMING' });
    const refreshed = await gateway.refreshBroadcasts(channel, ['video-1']);
    expect(refreshed.items[0]).toMatchObject({
      status: 'COMPLETED',
      endTimeProvisional: false,
    });
    expect(refreshed.items[0]?.actualEndAt?.toISOString()).toBe('2026-07-21T10:42:00.000Z');
  });

  it('returns omitted IDs as unavailable without treating them as cancelled', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json({ items: [] })));
    await expect(
      new YouTubeDataGateway('key').refreshBroadcasts(channel, ['missing-video']),
    ).resolves.toEqual({ items: [], unavailableVideoIds: ['missing-video'] });
  });

  it('normalizes a started stream as live and ignores an ordinary video', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        json({
          items: [
            {
              id: 'live-video',
              snippet: { title: 'live', liveBroadcastContent: 'live' },
              liveStreamingDetails: {
                scheduledStartTime: '2026-07-20T09:00:00Z',
                actualStartTime: '2026-07-20T09:02:00Z',
              },
            },
            { id: 'ordinary-video', snippet: { title: 'ordinary' } },
          ],
        }),
      ),
    );
    await expect(
      new YouTubeDataGateway('key').refreshBroadcasts(channel, ['live-video', 'ordinary-video']),
    ).resolves.toMatchObject({
      items: [{ youtubeVideoId: 'live-video', status: 'LIVE' }],
      unavailableVideoIds: ['ordinary-video'],
    });
  });

  it('classifies a temporary detail API failure as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json({}, 500)));
    await expect(
      new YouTubeDataGateway('key').refreshBroadcasts(channel, ['video-1']),
    ).rejects.toMatchObject({ code: 'YOUTUBE_API_ERROR', retryable: true });
  });

  it('defines the current official unit cost for each API method used by the design', () => {
    expect(YOUTUBE_QUOTA_COSTS).toEqual({
      'channels.list': { bucket: 'GENERAL', units: 1 },
      'playlistItems.list': { bucket: 'GENERAL', units: 1 },
      'videos.list': { bucket: 'GENERAL', units: 1 },
      'search.list': { bucket: 'SEARCH', units: 1 },
    });
  });

  it('reserves each retry and does not call the API after the application budget is exhausted', async () => {
    const store = new MemoryStore();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({}, 500));
    vi.stubGlobal('fetch', fetchMock);
    const gateway = new YouTubeDataGateway(
      'key',
      10_000,
      store,
      { now: () => new Date('2026-07-20T10:00:00Z') },
      { info: () => undefined, error: () => undefined },
      { ...quotaConfig, dailyBudget: 3, scheduledReserve: 0 },
      async () => undefined,
      () => 0,
    );
    await expect(gateway.refreshBroadcasts(channel, ['video-1'])).rejects.toMatchObject({
      code: 'YOUTUBE_API_ERROR',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await expect(gateway.refreshBroadcasts(channel, ['video-1'])).rejects.toMatchObject({
      code: 'YOUTUBE_QUOTA_DEFERRED',
      details: { nextRetryAt: expect.any(String) },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reserves one search unit for every pagination request', async () => {
    const store = new MemoryStore();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ items: [], nextPageToken: 'page-2' }))
      .mockResolvedValueOnce(json({ items: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const gateway = new YouTubeDataGateway(
      'key',
      10_000,
      store,
      { now: () => new Date('2026-07-20T10:00:00Z') },
      { info: () => undefined, error: () => undefined },
      { ...quotaConfig, dailySearchBudget: 2, scheduledSearchReserve: 0, maxSearchPages: 2 },
    );
    await expect(
      gateway.listUpcoming(
        channel,
        new Date('2026-07-20T00:00:00Z'),
        new Date('2026-08-20T00:00:00Z'),
      ),
    ).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(
      gateway.listUpcoming(
        channel,
        new Date('2026-07-20T00:00:00Z'),
        new Date('2026-08-20T00:00:00Z'),
      ),
    ).rejects.toMatchObject({ code: 'YOUTUBE_QUOTA_DEFERRED' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('deduplicates tracked IDs and sends at most 50 IDs per videos.list request', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => json({ items: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const ids = Array.from({ length: 100 }, (_, index) => `video-${index}`);
    await new YouTubeDataGateway('key').refreshBroadcasts(channel, [...ids, 'video-0']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url] of fetchMock.mock.calls) {
      const values = new URL(String(url)).searchParams.get('id')?.split(',') ?? [];
      expect(values).toHaveLength(50);
      expect(new Set(values).size).toBe(50);
    }
  });

  it('protects the scheduled reserve and starts a new budget after the quota date changes', async () => {
    const store = new MemoryStore();
    expect(
      await store.reserveYouTubeQuota('2026-07-20', 'SEARCH', 8, 80, 72, 'MANUAL'),
    ).toMatchObject({
      granted: true,
    });
    expect(
      await store.reserveYouTubeQuota('2026-07-20', 'SEARCH', 1, 80, 72, 'MANUAL'),
    ).toMatchObject({
      granted: false,
    });
    expect(
      await store.reserveYouTubeQuota('2026-07-20', 'SEARCH', 1, 80, 72, 'SCHEDULED'),
    ).toMatchObject({
      granted: true,
    });
    expect(
      await store.reserveYouTubeQuota('2026-07-21', 'SEARCH', 8, 80, 72, 'MANUAL'),
    ).toMatchObject({
      granted: true,
    });
  });

  it('uses the configured Pacific quota date and computes the next reset across DST', () => {
    const now = new Date('2026-11-01T07:30:00Z');
    expect(quotaDateAt(now, 'America/Los_Angeles')).toBe('2026-11-01');
    expect(quotaDateAt(nextQuotaResetAt(now, 'America/Los_Angeles'), 'America/Los_Angeles')).toBe(
      '2026-11-02',
    );
  });
});
