import { describe, expect, it, vi } from 'vitest';
import { SqsSyncJobDispatcher } from './sync-job-dispatcher.js';

describe('SqsSyncJobDispatcher', () => {
  it('sends only the opaque sync run identifier', async () => {
    const send = vi.fn(async () => ({}));
    const dispatcher = new SqsSyncJobDispatcher(
      'https://sqs.ap-northeast-1.amazonaws.com/111111111111/sync-jobs',
      { send } as never,
    );
    await dispatcher.dispatch('cm0wz73bk0000qzrmn831i7rn');
    const input = send.mock.calls[0]![0].input;
    expect(JSON.parse(input.MessageBody!)).toEqual({
      syncRunId: 'cm0wz73bk0000qzrmn831i7rn',
    });
    expect(input.MessageBody).not.toMatch(/token|secret|email|subscription/i);
  });

  it('propagates send failures so the durable job can be marked failed', async () => {
    const dispatcher = new SqsSyncJobDispatcher('https://sqs.example.invalid/sync-jobs', {
      send: vi.fn(async () => {
        throw new Error('unavailable');
      }),
    } as never);
    await expect(dispatcher.dispatch('cm0wz73bk0000qzrmn831i7rn')).rejects.toThrow('unavailable');
  });
});
