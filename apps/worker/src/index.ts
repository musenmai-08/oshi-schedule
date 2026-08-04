import { createRuntime } from '@oshi-schedule/api/runtime';
import { executeScheduledWorker, formatScheduledWorkerLog } from './scheduled-worker.js';

const runtime = createRuntime();
const outcome = await executeScheduledWorker(runtime.runScheduled);
process.stdout.write(`${formatScheduledWorkerLog(outcome)}\n`);
process.exitCode = outcome.exitCode;
