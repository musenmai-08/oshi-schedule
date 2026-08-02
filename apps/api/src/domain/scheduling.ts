import { createHash } from 'node:crypto';
import type { BroadcastKind, BroadcastStatus } from '@oshi-schedule/shared';

export interface NormalizedBroadcast {
  youtubeVideoId: string;
  title: string;
  kind: BroadcastKind;
  status: BroadcastStatus | 'UNKNOWN';
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
  const kindLabel =
    broadcast.kind === 'PREMIERE'
      ? 'プレミア公開'
      : broadcast.kind === 'LIVE'
        ? 'YouTube Live'
        : '配信（種別未確定）';
  return {
    summary: broadcast.title,
    description: [
      `チャンネル: ${channelTitle}`,
      `種別: ${kindLabel}`,
      `URL: ${broadcast.youtubeUrl}`,
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

/** Decides whether this user may receive a Calendar event for a broadcast snapshot. */
export function shouldSyncCalendarEvent(
  broadcast: NormalizedBroadcast,
  hasMapping: boolean,
  now: Date,
) {
  // Existing managed events remain updateable, including completion/unavailability history.
  if (hasMapping) return true;
  // A confirmed end is authoritative even if a stale source status still says UPCOMING/LIVE.
  if (broadcast.actualEndAt) return false;
  if (broadcast.status === 'LIVE') return true;
  if (broadcast.status !== 'UPCOMING') return false;
  // A provisional end does not end LIVE, but an unmapped scheduled item must still be future.
  return broadcast.scheduledStartAt.getTime() > now.getTime();
}

export const isFuture = (value: Date, now: Date) => value.getTime() >= now.getTime();
