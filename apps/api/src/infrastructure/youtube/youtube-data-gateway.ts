import { AppError } from '../../domain/errors.js';
import { calculateEndAt, type NormalizedBroadcast } from '../../domain/scheduling.js';
import type { ChannelRecord, YouTubeGateway } from '../../application/models.js';

interface YouTubeList<T> {
  items?: T[];
  nextPageToken?: string;
}
interface ChannelItem {
  id?: string;
  snippet?: {
    title?: string;
    customUrl?: string;
    thumbnails?: { high?: { url?: string }; default?: { url?: string } };
  };
}
interface SearchItem {
  id?: { videoId?: string };
}
interface VideoItem {
  id?: string;
  snippet?: {
    title?: string;
    liveBroadcastContent?: string;
    thumbnails?: { high?: { url?: string }; default?: { url?: string } };
  };
  liveStreamingDetails?: {
    scheduledStartTime?: string;
    actualStartTime?: string;
    actualEndTime?: string;
  };
  contentDetails?: { duration?: string };
  status?: { uploadStatus?: string };
}

export class YouTubeDataGateway implements YouTubeGateway {
  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs = 10_000,
  ) {}
  private async get<T>(path: string, params: URLSearchParams): Promise<T> {
    params.set('key', this.apiKey);
    const response = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${params}`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok)
      throw new AppError(
        response.status === 403 ? 'YOUTUBE_QUOTA_OR_FORBIDDEN' : 'YOUTUBE_API_ERROR',
        'YouTube情報を取得できませんでした',
        response.status === 404 ? 404 : 502,
        response.status >= 500 || response.status === 429,
      );
    return response.json() as Promise<T>;
  }
  async resolveHandle(handle: string) {
    const response = await this.get<YouTubeList<ChannelItem>>(
      'channels',
      new URLSearchParams({ part: 'snippet', forHandle: handle }),
    );
    const item = response.items?.[0];
    if (!item?.id || !item.snippet?.title)
      throw new AppError('CHANNEL_NOT_FOUND', 'チャンネルが見つかりません', 404);
    const canonicalHandle = item.snippet.customUrl?.startsWith('@')
      ? item.snippet.customUrl
      : handle;
    return {
      id: item.id,
      youtubeChannelId: item.id,
      title: item.snippet.title,
      handle: canonicalHandle,
      thumbnailUrl:
        item.snippet.thumbnails?.high?.url ?? item.snippet.thumbnails?.default?.url ?? '',
      channelUrl: `https://www.youtube.com/channel/${item.id}`,
    };
  }
  async listUpcoming(channel: ChannelRecord, from: Date, to: Date): Promise<NormalizedBroadcast[]> {
    const found = await this.get<YouTubeList<SearchItem>>(
      'search',
      new URLSearchParams({
        part: 'id',
        channelId: channel.youtubeChannelId,
        type: 'video',
        eventType: 'upcoming',
        maxResults: '50',
      }),
    );
    const ids =
      found.items?.map((item) => item.id?.videoId).filter((id): id is string => Boolean(id)) ?? [];
    if (!ids.length) return [];
    const details = await this.get<YouTubeList<VideoItem>>(
      'videos',
      new URLSearchParams({
        part: 'snippet,contentDetails,liveStreamingDetails,status',
        id: ids.join(','),
      }),
    );
    return (details.items ?? []).flatMap((item) => {
      const liveDetails = item.liveStreamingDetails;
      const rawStart = liveDetails?.scheduledStartTime;
      if (!item.id || !item.snippet?.title || !rawStart) return [];
      const start = new Date(rawStart);
      if (start < from || start > to) return [];
      // The third-party Data API has no durable explicit premiere flag. Short scheduled items are treated as premieres provisionally.
      const kind =
        item.contentDetails?.duration && item.contentDetails.duration !== 'P0D'
          ? ('PREMIERE' as const)
          : ('LIVE' as const);
      const actualEnd = liveDetails.actualEndTime ? new Date(liveDetails.actualEndTime) : null;
      const calculated = calculateEndAt(kind, start, actualEnd);
      return [
        {
          youtubeVideoId: item.id,
          title: item.snippet.title,
          kind,
          status:
            item.status?.uploadStatus === 'rejected'
              ? ('CANCELLED' as const)
              : ('UPCOMING' as const),
          youtubeUrl: `https://www.youtube.com/watch?v=${item.id}`,
          thumbnailUrl:
            item.snippet.thumbnails?.high?.url ?? item.snippet.thumbnails?.default?.url ?? '',
          scheduledStartAt: start,
          endAt: calculated.endAt,
          endTimeProvisional: calculated.provisional,
          actualStartAt: liveDetails.actualStartTime ? new Date(liveDetails.actualStartTime) : null,
          actualEndAt: actualEnd,
        },
      ];
    });
  }
}
