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
    scheduledEndTime?: string;
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
    let response: Response;
    try {
      response = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${params}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new AppError('YOUTUBE_API_UNAVAILABLE', 'YouTube情報を取得できませんでした', 502, true);
    }
    if (!response.ok)
      throw new AppError(
        response.status === 403 ? 'YOUTUBE_QUOTA_OR_FORBIDDEN' : 'YOUTUBE_API_ERROR',
        'YouTube情報を取得できませんでした',
        response.status === 404 ? 404 : 502,
        response.status >= 500 || response.status === 429,
      );
    return response.json() as Promise<T>;
  }
  private normalize(item: VideoItem): NormalizedBroadcast | null {
    const liveDetails = item.liveStreamingDetails;
    const rawStart = liveDetails?.scheduledStartTime;
    if (!item.id || !item.snippet?.title || !rawStart) return null;
    const start = new Date(rawStart);
    const actualEnd = liveDetails.actualEndTime ? new Date(liveDetails.actualEndTime) : null;
    const status = actualEnd
      ? ('COMPLETED' as const)
      : liveDetails.actualStartTime || item.snippet.liveBroadcastContent === 'live'
        ? ('LIVE' as const)
        : item.status?.uploadStatus === 'rejected'
          ? ('CANCELLED' as const)
          : ('UPCOMING' as const);
    // The public third-party video resource has no durable premiere discriminator.
    // Keep the kind unknown instead of turning duration into an unsupported assertion.
    const kind = 'UNKNOWN' as const;
    const calculated = calculateEndAt(kind, start, actualEnd);
    return {
      youtubeVideoId: item.id,
      title: item.snippet.title,
      kind,
      status,
      youtubeUrl: `https://www.youtube.com/watch?v=${item.id}`,
      thumbnailUrl:
        item.snippet.thumbnails?.high?.url ?? item.snippet.thumbnails?.default?.url ?? '',
      scheduledStartAt: start,
      endAt: calculated.endAt,
      endTimeProvisional: calculated.provisional,
      actualStartAt: liveDetails.actualStartTime ? new Date(liveDetails.actualStartTime) : null,
      actualEndAt: actualEnd,
    };
  }
  private async videoDetails(ids: string[]) {
    const items: VideoItem[] = [];
    for (let index = 0; index < ids.length; index += 50) {
      const chunk = ids.slice(index, index + 50);
      if (!chunk.length) continue;
      const details = await this.get<YouTubeList<VideoItem>>(
        'videos',
        new URLSearchParams({
          part: 'snippet,contentDetails,liveStreamingDetails,status',
          id: chunk.join(','),
        }),
      );
      items.push(...(details.items ?? []));
    }
    return items;
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
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        part: 'id',
        channelId: channel.youtubeChannelId,
        type: 'video',
        eventType: 'upcoming',
        maxResults: '50',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const found = await this.get<YouTubeList<SearchItem>>('search', params);
      ids.push(
        ...(found.items
          ?.map((item) => item.id?.videoId)
          .filter((id): id is string => Boolean(id)) ?? []),
      );
      pageToken = found.nextPageToken;
    } while (pageToken && ids.length < 500);
    if (!ids.length) return [];
    return (await this.videoDetails(ids)).flatMap((item) => {
      const normalized = this.normalize(item);
      if (!normalized) return [];
      const start = normalized.scheduledStartAt;
      if (start < from || start > to) return [];
      return [normalized];
    });
  }
  async refreshBroadcasts(_channel: ChannelRecord, youtubeVideoIds: string[]) {
    if (!youtubeVideoIds.length) return { items: [], unavailableVideoIds: [] };
    const details = await this.videoDetails([...new Set(youtubeVideoIds)]);
    const items = details.flatMap((item) => {
      const normalized = this.normalize(item);
      return normalized ? [normalized] : [];
    });
    const returned = new Set(items.map((item) => item.youtubeVideoId));
    return {
      items,
      unavailableVideoIds: youtubeVideoIds.filter((id) => !returned.has(id)),
    };
  }
}
