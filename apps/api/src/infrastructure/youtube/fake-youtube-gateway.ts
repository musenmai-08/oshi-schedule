import { createHash } from 'node:crypto';
import type { ChannelSummary } from '@oshi-schedule/shared';
import type { ChannelRecord, YouTubeGateway } from '../../application/models.js';
import { calculateEndAt, type NormalizedBroadcast } from '../../domain/scheduling.js';

export class FakeYouTubeGateway implements YouTubeGateway {
  private readonly known = new Map<string, NormalizedBroadcast>();
  async resolveHandle(handle: string): Promise<ChannelSummary> {
    const seed = createHash('sha1').update(handle.toLowerCase()).digest('hex').slice(0, 12);
    return {
      id: `channel-${seed}`,
      youtubeChannelId: `UC${seed}`,
      title: `${handle.slice(1)} チャンネル`,
      handle,
      thumbnailUrl: `https://placehold.co/160x160/ff416c/ffffff?text=${encodeURIComponent(handle.slice(1, 2).toUpperCase())}`,
      channelUrl: `https://www.youtube.com/${handle}`,
    };
  }
  async listUpcoming(channel: ChannelRecord, from: Date, to: Date) {
    const start = new Date(from.getTime() + 24 * 60 * 60_000);
    if (start > to) return [];
    const end = calculateEndAt('LIVE', start);
    const items = [
      {
        youtubeVideoId: `fake-${channel.youtubeChannelId}`,
        title: '次回の推し配信',
        kind: 'LIVE' as const,
        status: 'UPCOMING' as const,
        youtubeUrl: `https://youtu.be/fake-${channel.youtubeChannelId}`,
        thumbnailUrl: 'https://placehold.co/640x360/311b92/ffffff?text=YouTube+Live',
        scheduledStartAt: start,
        endAt: end.endAt,
        endTimeProvisional: end.provisional,
        actualStartAt: null,
        actualEndAt: null,
      },
    ];
    items.forEach((item) => this.known.set(item.youtubeVideoId, item));
    return items;
  }
  setBroadcast(item: NormalizedBroadcast) {
    this.known.set(item.youtubeVideoId, item);
  }
  async refreshBroadcasts(_channel: ChannelRecord, youtubeVideoIds: string[]) {
    const items = youtubeVideoIds.flatMap((id) => {
      const item = this.known.get(id);
      return item ? [item] : [];
    });
    return {
      items,
      unavailableVideoIds: youtubeVideoIds.filter((id) => !this.known.has(id)),
    };
  }
}
