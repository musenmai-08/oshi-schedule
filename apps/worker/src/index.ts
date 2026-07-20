import { createRuntime } from '@oshi-schedule/api/runtime';

const runtime = createRuntime();
const results = await runtime.runScheduled();
const failed = results.filter((result) => result.status === 'FAILED').length;
process.stdout.write(
  `${JSON.stringify({ level: failed ? 'warn' : 'info', event: 'scheduled_sync_completed', targets: results.length, failed })}\n`,
);
if (failed === results.length && failed > 0) process.exitCode = 1;
