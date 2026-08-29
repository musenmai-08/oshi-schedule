import { inspectQueuedSyncRunsWithPrisma } from '@oshi-schedule/api/read-only-ops';

try {
  process.stdout.write(`${JSON.stringify(await inspectQueuedSyncRunsWithPrisma())}\n`);
} catch {
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      event: 'queued_sync_run_inspection_failed',
      errorCode: 'QUEUED_SYNC_RUN_INSPECTION_FAILED',
    })}\n`,
  );
  process.exitCode = 1;
}
