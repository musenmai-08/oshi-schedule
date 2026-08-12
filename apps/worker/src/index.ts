import { createRuntime } from '@oshi-schedule/api/runtime';
import {
  executeScheduledWorkerLifecycle,
  formatScheduledWorkerLog,
  selectWorkerExecution,
} from './scheduled-worker.js';

const runtime = createRuntime();
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

const execute = selectWorkerExecution(
  process.env.SYNC_RUN_ID,
  runtime.runScheduled,
  runtime.runTargeted,
);
const outcome = await executeScheduledWorkerLifecycle(async () => {
  const result = await execute();
  return Array.isArray(result) ? result : [result];
}, runtime.disconnect);
process.stdout.write(`${formatScheduledWorkerLog(outcome)}\n`);
process.exitCode = signalReceived ? 1 : outcome.exitCode;
