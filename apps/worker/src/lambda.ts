import type { Handler, SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { createRuntime } from '@oshi-schedule/api/runtime';
import { loadLambdaRuntimeEnvironment } from '@oshi-schedule/api/lambda-env';
import { summarizeScheduledResults, workerFailureFrom } from './scheduled-worker.js';

interface WorkerRuntime {
  runScheduled(): Promise<ReadonlyArray<{ status: string }>>;
  runTargeted(syncRunId: string): Promise<{ status: string }>;
}

type WorkerJob = { kind: 'scheduled' } | { syncRunId: string };

const parseWorkerJob = (body: string): WorkerJob => {
  const value = JSON.parse(body) as unknown;
  if (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'scheduled'
  )
    return { kind: 'scheduled' };
  if (
    typeof value !== 'object' ||
    value === null ||
    !('syncRunId' in value) ||
    typeof value.syncRunId !== 'string' ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(value.syncRunId)
  )
    throw new Error('Invalid sync job payload');
  return { syncRunId: value.syncRunId };
};

const safeFailure = (event: string, error: unknown, extra: Record<string, string> = {}) => {
  const failure = workerFailureFrom(error, 'SYNC_EXECUTION');
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      event,
      ...extra,
      failurePhase: failure.phase,
      failureCode: failure.errorCode,
      failureClass: failure.errorClass,
    })}\n`,
  );
};

export const createWorkerLambdaHandler =
  (getRuntime: () => Promise<WorkerRuntime>): Handler<SQSEvent, SQSBatchResponse> =>
  async (event) => {
    let runtime: WorkerRuntime;
    try {
      runtime = await getRuntime();
    } catch (error) {
      safeFailure('worker_initialization_failed', error, {});
      throw new Error('Worker initialization failed safely');
    }
    const batchItemFailures: Array<{ itemIdentifier: string }> = [];
    for (const record of event.Records) {
      try {
        const job = parseWorkerJob(record.body);
        if ('kind' in job) {
          const summary = summarizeScheduledResults(await runtime.runScheduled());
          process.stdout.write(
            `${JSON.stringify({ level: 'info', event: 'scheduled_sync_completed', ...summary })}\n`,
          );
          continue;
        }
        const result = await runtime.runTargeted(job.syncRunId);
        process.stdout.write(
          `${JSON.stringify({
            level: result.status === 'FAILED' ? 'warn' : 'info',
            event: 'targeted_sync_completed',
            messageId: record.messageId,
            status: result.status,
          })}\n`,
        );
      } catch (error) {
        batchItemFailures.push({ itemIdentifier: record.messageId });
        safeFailure('sync_job_failed', error, { messageId: record.messageId });
      }
    }
    return { batchItemFailures };
  };

let runtime: Promise<WorkerRuntime> | undefined;

const bootstrap = async () => {
  await loadLambdaRuntimeEnvironment('worker');
  return createRuntime();
};

export const handler = createWorkerLambdaHandler(async () => {
  runtime ??= bootstrap();
  try {
    return await runtime;
  } catch (error) {
    runtime = undefined;
    throw error;
  }
});
