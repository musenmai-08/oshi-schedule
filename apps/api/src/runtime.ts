import { createContainer } from './container.js';
import { loadWorkerEnv } from './infrastructure/env.js';

export function createWorkerRuntime(source: NodeJS.ProcessEnv = process.env) {
  const env = loadWorkerEnv(source);
  const container = createContainer(env);
  return {
    env,
    container,
    runScheduled: async () => [
      ...(await container.service.sync.runPendingManual()),
      ...(await container.service.sync.runScheduled()),
    ],
    runTargeted: (syncRunId: string) => container.service.sync.runTargeted(syncRunId),
    disconnect: () => container.resources.disconnect(),
  };
}

// This is the existing Worker package export. Keep it while consumers migrate to
// the explicit name, so the workspace can typecheck against a previously built API.
export const createRuntime = createWorkerRuntime;
