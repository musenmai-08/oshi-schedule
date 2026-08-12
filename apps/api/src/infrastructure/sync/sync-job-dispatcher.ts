import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { AppLogger, SyncJobDispatcher } from '../../application/models.js';

export class SqsSyncJobDispatcher implements SyncJobDispatcher {
  constructor(
    private readonly queueUrl: string,
    private readonly client = new SQSClient({}),
  ) {}

  async dispatch(syncRunId: string) {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify({ syncRunId }),
      }),
      { abortSignal: AbortSignal.timeout(3_000) },
    );
  }
}

export class LocalSyncJobDispatcher implements SyncJobDispatcher {
  constructor(
    private readonly execute: (syncRunId: string) => Promise<unknown>,
    private readonly logger: AppLogger,
  ) {}

  async dispatch(syncRunId: string) {
    setTimeout(() => {
      void this.execute(syncRunId).catch(() => {
        this.logger.error(
          { syncRunId, errorCode: 'LOCAL_SYNC_JOB_FAILED' },
          'local sync job failed',
        );
      });
    }, 0);
  }
}
