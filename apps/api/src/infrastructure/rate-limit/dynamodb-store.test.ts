import { describe, expect, it, vi } from 'vitest';
import { DynamoDbRateLimitStore } from './dynamodb-store.js';

describe('DynamoDbRateLimitStore', () => {
  it('uses one atomic counter shared by all Lambda instances in a fixed window', async () => {
    const send = vi.fn(async () => ({ Attributes: { totalHits: 4 } }));
    const store = new DynamoDbRateLimitStore('rate-limits', { send });
    store.init({ windowMs: 60_000 } as never);

    const result = await store.increment('203.0.113.10');

    expect(result.totalHits).toBe(4);
    expect(result.resetTime).toBeInstanceOf(Date);
    expect(send.mock.calls[0]![0].input).toMatchObject({
      TableName: 'rate-limits',
      Key: { id: expect.stringMatching(/^api:\d+:203\.0\.113\.10$/) },
      ReturnValues: 'ALL_NEW',
    });
  });
});
