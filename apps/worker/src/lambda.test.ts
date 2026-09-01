import type { ScheduledEvent, SQSEvent } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { createWorkerLambdaHandler } from './lambda.js';

const sqsEvent = (bodies: string[]): SQSEvent => ({
  Records: bodies.map((body, index) => ({
    messageId: `message-${index}`,
    receiptHandle: 'receipt',
    body,
    attributes: {
      ApproximateReceiveCount: '1',
      SentTimestamp: '0',
      SenderId: 'sender',
      ApproximateFirstReceiveTimestamp: '0',
    },
    messageAttributes: {},
    md5OfBody: 'md5',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:ap-northeast-1:111111111111:sync-jobs',
    awsRegion: 'ap-northeast-1',
  })),
});

describe('Worker Lambda handler', () => {
  it('processes targeted SQS work and returns only retryable record failures', async () => {
    const runTargeted = vi
      .fn()
      .mockResolvedValueOnce({ status: 'SUCCESS' })
      .mockRejectedValueOnce(new Error('temporary failure'));
    const handler = createWorkerLambdaHandler(async () => ({
      runTargeted,
      runScheduled: vi.fn(),
    }));

    const response = await handler(
      sqsEvent([
        JSON.stringify({ syncRunId: 'cm0wz73bk0000qzrmn831i7rn' }),
        JSON.stringify({ syncRunId: 'cm0wz73bk0000qzrmn831i7ro' }),
      ]),
      {} as never,
      () => undefined,
    );

    expect(runTargeted).toHaveBeenCalledTimes(2);
    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: 'message-1' }] });
  });

  it('runs recovery and scheduled synchronization from Scheduler without creating SQS work', async () => {
    const runScheduled = vi.fn(async () => [{ status: 'SUCCESS' }, { status: 'DEFERRED' }]);
    const runTargeted = vi.fn();
    const handler = createWorkerLambdaHandler(async () => ({ runTargeted, runScheduled }));

    await handler(
      {
        version: '0',
        id: 'event-id',
        'detail-type': 'scheduled-sync',
        source: 'oshi-schedule.scheduler',
        account: '111111111111',
        time: '2026-09-01T00:00:00Z',
        region: 'ap-northeast-1',
        resources: [],
        detail: { kind: 'scheduled' },
      } satisfies ScheduledEvent<{ kind: 'scheduled' }>,
      {} as never,
      () => undefined,
    );

    expect(runScheduled).toHaveBeenCalledOnce();
    expect(runTargeted).not.toHaveBeenCalled();
  });

  it('sends invalid payloads to SQS retry without logging the body', async () => {
    const handler = createWorkerLambdaHandler(async () => ({
      runTargeted: vi.fn(),
      runScheduled: vi.fn(),
    }));
    const response = await handler(
      sqsEvent(['{"email":"private@example.com"}']),
      {} as never,
      () => undefined,
    );
    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: 'message-0' }] });
  });

  it('sanitizes scheduler and bootstrap failures before Lambda reports them', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const scheduled = createWorkerLambdaHandler(async () => ({
      runTargeted: vi.fn(),
      runScheduled: vi.fn().mockRejectedValue(new Error('refresh-token-should-not-be-logged')),
    }));
    await expect(
      scheduled(
        {
          version: '0',
          id: 'event-id',
          'detail-type': 'scheduled-sync',
          source: 'test',
          account: '111111111111',
          time: '2026-09-01T00:00:00Z',
          region: 'ap-northeast-1',
          resources: [],
          detail: { kind: 'scheduled' },
        } satisfies ScheduledEvent<{ kind: 'scheduled' }>,
        {} as never,
        () => undefined,
      ),
    ).rejects.toThrow('Scheduled synchronization failed safely');
    expect(write).toHaveBeenCalledWith(
      expect.not.stringContaining('refresh-token-should-not-be-logged'),
    );
    write.mockRestore();
  });
});
