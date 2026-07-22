import { AppError } from '../../domain/errors.js';
import { calculateEndAt, type NormalizedBroadcast } from '../../domain/scheduling.js';
import type {
  AppLogger,
  ChannelRecord,
  Clock,
  Store,
  YouTubeGateway,
  YouTubeRequestContext,
} from '../../application/models.js';
import {
  nextQuotaResetAt,
  quotaDateAt,
  YOUTUBE_QUOTA_COSTS,
  YOUTUBE_VIDEOS_LIST_BATCH_SIZE,
  type YouTubeQuotaMethod,
} from './youtube-quota.js';

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
    private readonly quotaStore?: Store,
    private readonly clock: Clock = { now: () => new Date() },
    private readonly logger: AppLogger = { info: () => undefined, error: () => undefined },
    private readonly quotaConfig = {
      dailyBudget: 8_000,
      dailySearchBudget: 80,
      scheduledReserve: 432,
      scheduledSearchReserve: 72,
      timeZone: 'America/Los_Angeles',
      maxSearchPages: 1,
      maxAttempts: 3,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 5_000,
    },
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly random: () => number = Math.random,
  ) {}
  private async reserve(method: YouTubeQuotaMethod, context: YouTubeRequestContext) {
    if (!this.quotaStore) return null;
    const now = this.clock.now();
    const quotaDate = quotaDateAt(now, this.quotaConfig.timeZone);
    const cost = YOUTUBE_QUOTA_COSTS[method];
    const search = cost.bucket === 'SEARCH';
    const reservation = await this.quotaStore.reserveYouTubeQuota(
      quotaDate,
      cost.bucket,
      cost.units,
      search ? this.quotaConfig.dailySearchBudget : this.quotaConfig.dailyBudget,
      search ? this.quotaConfig.scheduledSearchReserve : this.quotaConfig.scheduledReserve,
      context.mode,
    );
    this.logger.info(
      {
        event: 'youtube_quota_reservation',
        method,
        bucket: cost.bucket,
        requestedUnits: cost.units,
        unitsUsed: reservation.unitsUsed,
        unitsReserved: reservation.unitsReserved,
        remainingUnits: reservation.remaining,
        granted: reservation.granted,
        mode: context.mode,
        runId: context.runId,
      },
      'YouTube quota reservation',
    );
    if (!reservation.granted) {
      const nextRetryAt = nextQuotaResetAt(now, this.quotaConfig.timeZone).toISOString();
      throw new AppError(
        'YOUTUBE_QUOTA_DEFERRED',
        'YouTube情報の更新を次回同期まで延期しました',
        429,
        true,
        { nextRetryAt },
      );
    }
    return { quotaDate, ...cost };
  }
  private async get<T>(
    path: 'channels' | 'search' | 'videos',
    params: URLSearchParams,
    context: YouTubeRequestContext,
  ): Promise<T> {
    params.set('key', this.apiKey);
    const method = `${path}.list` as YouTubeQuotaMethod;
    for (let attempt = 0; attempt < this.quotaConfig.maxAttempts; attempt += 1) {
      const reservation = await this.reserve(method, context);
      let response: Response;
      try {
        response = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${params}`, {
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (reservation)
          await this.quotaStore?.consumeYouTubeQuota(
            reservation.quotaDate,
            reservation.bucket,
            reservation.units,
          );
        if (attempt + 1 < this.quotaConfig.maxAttempts) {
          await this.sleep(
            Math.min(
              this.quotaConfig.retryMaxDelayMs,
              this.quotaConfig.retryBaseDelayMs * 2 ** attempt +
                Math.floor(this.random() * this.quotaConfig.retryBaseDelayMs),
            ),
          );
          continue;
        }
        const timedOut =
          error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        throw new AppError(
          timedOut ? 'YOUTUBE_API_TIMEOUT' : 'YOUTUBE_API_UNAVAILABLE',
          'YouTube情報を取得できませんでした',
          502,
          true,
        );
      }
      if (reservation)
        await this.quotaStore?.consumeYouTubeQuota(
          reservation.quotaDate,
          reservation.bucket,
          reservation.units,
        );
      if (response.ok) return response.json() as Promise<T>;
      const retryable = response.status >= 500 || response.status === 429;
      if (retryable && attempt + 1 < this.quotaConfig.maxAttempts) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const delay =
          this.quotaConfig.retryBaseDelayMs * 2 ** attempt +
          Math.floor(this.random() * this.quotaConfig.retryBaseDelayMs);
        await this.sleep(
          Math.min(
            this.quotaConfig.retryMaxDelayMs,
            Number.isFinite(retryAfter) ? Math.max(delay, retryAfter * 1_000) : delay,
          ),
        );
        continue;
      }
      throw new AppError(
        response.status === 403 ? 'YOUTUBE_QUOTA_OR_FORBIDDEN' : 'YOUTUBE_API_ERROR',
        'YouTube情報を取得できませんでした',
        response.status === 404 ? 404 : 502,
        retryable,
      );
    }
    throw new AppError('YOUTUBE_API_ERROR', 'YouTube情報を取得できませんでした', 502, true);
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
  private async videoDetails(ids: string[], context: YouTubeRequestContext) {
    const items: VideoItem[] = [];
    for (let index = 0; index < ids.length; index += YOUTUBE_VIDEOS_LIST_BATCH_SIZE) {
      const chunk = ids.slice(index, index + YOUTUBE_VIDEOS_LIST_BATCH_SIZE);
      if (!chunk.length) continue;
      const details = await this.get<YouTubeList<VideoItem>>(
        'videos',
        new URLSearchParams({
          part: 'snippet,contentDetails,liveStreamingDetails,status',
          id: chunk.join(','),
        }),
        context,
      );
      items.push(...(details.items ?? []));
    }
    return items;
  }
  async resolveHandle(handle: string, context: YouTubeRequestContext = { mode: 'MANUAL' }) {
    const response = await this.get<YouTubeList<ChannelItem>>(
      'channels',
      new URLSearchParams({ part: 'snippet', forHandle: handle }),
      context,
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
  async listUpcoming(
    channel: ChannelRecord,
    from: Date,
    to: Date,
    context: YouTubeRequestContext = { mode: 'SCHEDULED' },
  ): Promise<NormalizedBroadcast[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const params = new URLSearchParams({
        part: 'id',
        channelId: channel.youtubeChannelId,
        type: 'video',
        eventType: 'upcoming',
        maxResults: '50',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const found = await this.get<YouTubeList<SearchItem>>('search', params, context);
      pages += 1;
      ids.push(
        ...(found.items
          ?.map((item) => item.id?.videoId)
          .filter((id): id is string => Boolean(id)) ?? []),
      );
      pageToken = found.nextPageToken;
    } while (pageToken && pages < this.quotaConfig.maxSearchPages);
    if (!ids.length) return [];
    return (await this.videoDetails(ids, context)).flatMap((item) => {
      const normalized = this.normalize(item);
      if (!normalized) return [];
      const start = normalized.scheduledStartAt;
      if (start < from || start > to) return [];
      return [normalized];
    });
  }
  async refreshBroadcasts(
    _channel: ChannelRecord,
    youtubeVideoIds: string[],
    context: YouTubeRequestContext = { mode: 'SCHEDULED' },
  ) {
    if (!youtubeVideoIds.length) return { items: [], unavailableVideoIds: [] };
    const details = await this.videoDetails([...new Set(youtubeVideoIds)], context);
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
