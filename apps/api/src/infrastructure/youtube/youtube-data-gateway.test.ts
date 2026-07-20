import { afterEach, describe, expect, it, vi } from 'vitest';
import { YouTubeDataGateway } from './youtube-data-gateway.js';
import type { ChannelRecord } from '../../application/models.js';

const channel: ChannelRecord = {
  id: 'cm0wz73bk0000qzrmn831i7rn',
  youtubeChannelId: 'UC-test',
  title: 'channel',
  handle: '@channel',
  thumbnailUrl: '',
  channelUrl: '',
  lastFetchedAt: null,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => vi.unstubAllGlobals());

describe('YouTubeDataGateway', () => {
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
});
