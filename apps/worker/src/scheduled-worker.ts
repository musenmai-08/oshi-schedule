export interface ScheduledSyncSummary {
  total: number;
  success: number;
  skipped: number;
  deferred: number;
  failed: number;
}

export interface ScheduledWorkerOutcome {
  exitCode: 0 | 1;
  summary: ScheduledSyncSummary;
  errorCode?: 'WORKER_UNHANDLED_ERROR' | 'WORKER_DISCONNECT_FAILED';
  failure?: WorkerFailure;
}

export interface WorkerFailure {
  phase:
    | 'INITIALIZATION'
    | 'SYNC_RUN_CLAIM'
    | 'DATABASE'
    | 'CREDENTIAL_DECRYPT'
    | 'GOOGLE_AUTH'
    | 'YOUTUBE'
    | 'CALENDAR'
    | 'SYNC_EXECUTION'
    | 'SHUTDOWN';
  errorCode: string;
  errorClass: 'APP_ERROR' | 'PRISMA_CLIENT_ERROR' | 'UNKNOWN_ERROR';
}

const workerFailurePhases = new Set<WorkerFailure['phase']>([
  'INITIALIZATION',
  'SYNC_RUN_CLAIM',
  'DATABASE',
  'CREDENTIAL_DECRYPT',
  'GOOGLE_AUTH',
  'YOUTUBE',
  'CALENDAR',
  'SYNC_EXECUTION',
  'SHUTDOWN',
]);

const workerErrorClasses = new Set<WorkerFailure['errorClass']>([
  'APP_ERROR',
  'PRISMA_CLIENT_ERROR',
  'UNKNOWN_ERROR',
]);

export function selectWorkerExecution(
  syncRunId: string | undefined,
  runScheduled: () => Promise<ReadonlyArray<{ status: string }>>,
  runTargeted: (syncRunId: string) => Promise<{ status: string }>,
) {
  const normalizedId = syncRunId?.trim();
  return normalizedId ? async () => [await runTargeted(normalizedId)] : runScheduled;
}

export async function executeScheduledWorkerLifecycle(
  runScheduled: () => Promise<ReadonlyArray<{ status: string }>>,
  disconnect: () => Promise<void>,
): Promise<ScheduledWorkerOutcome> {
  const outcome = await executeScheduledWorker(runScheduled);
  try {
    await disconnect();
    return outcome;
  } catch (error) {
    return {
      ...outcome,
      exitCode: 1,
      errorCode: 'WORKER_DISCONNECT_FAILED',
      failure: workerFailureFrom(error, 'SHUTDOWN'),
    };
  }
}

const emptySummary = (): ScheduledSyncSummary => ({
  total: 0,
  success: 0,
  skipped: 0,
  deferred: 0,
  failed: 0,
});

const hasSafeWorkerFailure = (error: unknown): error is { failure: WorkerFailure } => {
  if (typeof error !== 'object' || error === null || !('failure' in error)) return false;
  const failure = error.failure;
  return (
    typeof failure === 'object' &&
    failure !== null &&
    'phase' in failure &&
    typeof failure.phase === 'string' &&
    workerFailurePhases.has(failure.phase as WorkerFailure['phase']) &&
    'errorCode' in failure &&
    typeof failure.errorCode === 'string' &&
    /^[A-Z][A-Z0-9_]{1,79}$/.test(failure.errorCode) &&
    'errorClass' in failure &&
    typeof failure.errorClass === 'string' &&
    workerErrorClasses.has(failure.errorClass as WorkerFailure['errorClass'])
  );
};

export const workerFailureFrom = (
  error: unknown,
  fallbackPhase: WorkerFailure['phase'],
): WorkerFailure =>
  hasSafeWorkerFailure(error)
    ? error.failure
    : { phase: fallbackPhase, errorCode: 'UNEXPECTED_ERROR', errorClass: 'UNKNOWN_ERROR' };

export const workerInitializationFailure = (error: unknown): ScheduledWorkerOutcome => ({
  exitCode: 1,
  summary: emptySummary(),
  errorCode: 'WORKER_UNHANDLED_ERROR',
  failure: workerFailureFrom(error, 'INITIALIZATION'),
});

export function summarizeScheduledResults(results: ReadonlyArray<{ status: string }>) {
  const summary = emptySummary();
  summary.total = results.length;
  for (const result of results) {
    switch (result.status) {
      case 'SUCCESS':
        summary.success += 1;
        break;
      case 'SKIPPED':
        summary.skipped += 1;
        break;
      case 'DEFERRED':
        summary.deferred += 1;
        break;
      case 'FAILED':
        summary.failed += 1;
        break;
      default:
        // An unknown terminal state means the worker result cannot be trusted.
        summary.failed += 1;
    }
  }
  return summary;
}

export async function executeScheduledWorker(
  runScheduled: () => Promise<ReadonlyArray<{ status: string }>>,
): Promise<ScheduledWorkerOutcome> {
  try {
    const summary = summarizeScheduledResults(await runScheduled());
    return { exitCode: summary.failed > 0 ? 1 : 0, summary };
  } catch (error) {
    return {
      exitCode: 1,
      summary: emptySummary(),
      errorCode: 'WORKER_UNHANDLED_ERROR',
      failure: workerFailureFrom(error, 'SYNC_EXECUTION'),
    };
  }
}

export function formatScheduledWorkerLog(outcome: ScheduledWorkerOutcome) {
  return JSON.stringify({
    level: outcome.exitCode === 0 ? 'info' : 'error',
    event: 'scheduled_sync_completed',
    ...outcome.summary,
    ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
    ...(outcome.failure
      ? {
          failurePhase: outcome.failure.phase,
          failureCode: outcome.failure.errorCode,
          failureClass: outcome.failure.errorClass,
        }
      : {}),
  });
}
