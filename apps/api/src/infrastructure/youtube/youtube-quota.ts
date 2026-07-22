import type { YouTubeQuotaBucket } from '../../application/models.js';

export const YOUTUBE_QUOTA_COSTS = {
  'channels.list': { bucket: 'GENERAL', units: 1 },
  'playlistItems.list': { bucket: 'GENERAL', units: 1 },
  'videos.list': { bucket: 'GENERAL', units: 1 },
  'search.list': { bucket: 'SEARCH', units: 1 },
} as const satisfies Record<string, { bucket: YouTubeQuotaBucket; units: number }>;

export type YouTubeQuotaMethod = keyof typeof YOUTUBE_QUOTA_COSTS;

export function quotaDateAt(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function nextQuotaResetAt(now: Date, timeZone: string) {
  const currentDate = quotaDateAt(now, timeZone);
  let low = now.getTime();
  let high = low + 30 * 60 * 60_000;
  while (quotaDateAt(new Date(high), timeZone) === currentDate) high += 24 * 60 * 60_000;
  while (high - low > 1_000) {
    const middle = Math.floor((low + high) / 2);
    if (quotaDateAt(new Date(middle), timeZone) === currentDate) low = middle;
    else high = middle;
  }
  return new Date(high);
}
