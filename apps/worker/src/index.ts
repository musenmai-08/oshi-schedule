import { createRuntime } from '@oshi-schedule/api/runtime';
import { executeScheduledWorkerLifecycle, formatScheduledWorkerLog } from './scheduled-worker.js';

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

const outcome = await executeScheduledWorkerLifecycle(runtime.runScheduled, runtime.disconnect);
process.stdout.write(`${formatScheduledWorkerLog(outcome)}\n`);
process.exitCode = signalReceived ? 1 : outcome.exitCode;
