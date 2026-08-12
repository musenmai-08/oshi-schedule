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
}

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
  } catch {
    return { ...outcome, exitCode: 1, errorCode: 'WORKER_DISCONNECT_FAILED' };
  }
}

const emptySummary = (): ScheduledSyncSummary => ({
  total: 0,
  success: 0,
  skipped: 0,
  deferred: 0,
  failed: 0,
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
  } catch {
    return {
      exitCode: 1,
      summary: emptySummary(),
      errorCode: 'WORKER_UNHANDLED_ERROR',
    };
  }
}

export function formatScheduledWorkerLog(outcome: ScheduledWorkerOutcome) {
  return JSON.stringify({
    level: outcome.exitCode === 0 ? 'info' : 'error',
    event: 'scheduled_sync_completed',
    ...outcome.summary,
    ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
  });
}
