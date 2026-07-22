import { describe, expect, it } from 'vitest';
import { calculateYouTubeDailyQuotaBounds } from './youtube-quota.js';

describe('YouTube quota bounds', () => {
  it.each([
    [0, 0],
    [50, 1],
    [51, 2],
    [100, 2],
  ])('uses %s tracked videos as %s videos.list batches', (tracked, batches) => {
    expect(
      calculateYouTubeDailyQuotaBounds({
        maxSearchPages: 1,
        maxTrackedBroadcastsPerChannel: tracked,
        maxAttempts: 3,
      }).trackedBatches,
    ).toBe(batches);
  });

  it('computes a finite maximum including 3 channels, hourly runs, pages and retries', () => {
    expect(
      calculateYouTubeDailyQuotaBounds({
        maxSearchPages: 1,
        maxTrackedBroadcastsPerChannel: 50,
        maxAttempts: 3,
      }),
    ).toEqual({
      trackedBatches: 1,
      channelRuns: 72,
      generalPerChannelRun: 2,
      scheduledSearchWithoutRetries: 72,
      scheduledGeneralWithoutRetries: 144,
      scheduledSearchWithRetries: 216,
      scheduledGeneralWithRetries: 432,
    });
  });
});
