import { createHash } from 'node:crypto';
import type { BroadcastKind, BroadcastStatus } from '@oshi-schedule/shared';

export interface NormalizedBroadcast {
  youtubeVideoId: string;
  title: string;
  kind: BroadcastKind;
  status: BroadcastStatus;
  youtubeUrl: string;
  thumbnailUrl: string;
  scheduledStartAt: Date;
  endAt: Date;
  endTimeProvisional: boolean;
  actualStartAt: Date | null;
  actualEndAt: Date | null;
}

export function calculateEndAt(kind: BroadcastKind, start: Date, suppliedEnd?: Date | null) {
  if (suppliedEnd) return { endAt: suppliedEnd, provisional: false };
  const minutes = kind === 'PREMIERE' ? 30 : 60;
  return { endAt: new Date(start.getTime() + minutes * 60_000), provisional: true };
}

export interface CalendarEventInput {
  summary: string;
  description: string;
  start: string;
  end: string;
  status: 'confirmed' | 'cancelled';
  extendedProperties: { private: Record<string, string> };
}

export function buildCalendarEvent(
  broadcast: NormalizedBroadcast,
  channelTitle: string,
): CalendarEventInput {
  const prefix = broadcast.kind === 'PREMIERE' ? '【プレミア公開】' : '【YouTube Live】';
  const cancelled = broadcast.status === 'CANCELLED' ? '【中止】' : '';
  const kindLabel = broadcast.kind === 'PREMIERE' ? 'プレミア公開' : 'YouTube Live';
  return {
    summary: `${cancelled}${prefix}${broadcast.title}`,
    description: [
      `チャンネル: ${channelTitle}`,
      `種別: ${kindLabel}`,
      `URL: ${broadcast.youtubeUrl}`,
      `サムネイル: ${broadcast.thumbnailUrl}`,
    ].join('\n'),
    start: broadcast.scheduledStartAt.toISOString(),
    end: broadcast.endAt.toISOString(),
    status: broadcast.status === 'CANCELLED' ? 'cancelled' : 'confirmed',
    extendedProperties: {
      private: { managedBy: 'oshi-schedule', youtubeVideoId: broadcast.youtubeVideoId },
    },
  };
}

export function managedFieldsHash(event: CalendarEventInput) {
  return createHash('sha256').update(JSON.stringify(event)).digest('hex');
}

export const isFuture = (value: Date, now: Date) => value.getTime() >= now.getTime();
