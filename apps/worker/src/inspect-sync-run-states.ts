import { inspectInitialManualSyncRunsWithPrisma } from '@oshi-schedule/api/read-only-sync-run-states';

try {
  process.stdout.write(`${JSON.stringify(await inspectInitialManualSyncRunsWithPrisma())}\n`);
} catch {
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      event: 'sync_run_state_inspection_failed',
      errorCode: 'SYNC_RUN_STATE_INSPECTION_FAILED',
    })}\n`,
  );
  process.exitCode = 1;
}
