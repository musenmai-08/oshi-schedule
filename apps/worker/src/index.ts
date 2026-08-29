import { createRuntime } from '@oshi-schedule/api/runtime';
import {
  executeScheduledWorkerLifecycle,
  formatScheduledWorkerLog,
  selectWorkerExecution,
  workerInitializationFailure,
} from './scheduled-worker.js';

let signalReceived = false;
const handleSignal = (signal: 'SIGTERM' | 'SIGINT') => {
  if (signalReceived) return;
  signalReceived = true;
  process.stdout.write(
    `${JSON.stringify({ level: 'info', event: 'worker_shutdown_requested', signal })}\n`,
  );
};
process.once('SIGTERM', () => handleSignal('SIGTERM'));
process.once('SIGINT', () => handleSignal('SIGINT'));

let outcome;
try {
  const runtime = createRuntime();
  const execute = selectWorkerExecution(
    process.env.SYNC_RUN_ID,
    runtime.runScheduled,
    runtime.runTargeted,
  );
  outcome = await executeScheduledWorkerLifecycle(async () => {
    const result = await execute();
    return Array.isArray(result) ? result : [result];
  }, runtime.disconnect);
} catch (error) {
  outcome = workerInitializationFailure(error);
}
process.stdout.write(`${formatScheduledWorkerLog(outcome)}\n`);
process.exitCode = signalReceived ? 1 : outcome.exitCode;
