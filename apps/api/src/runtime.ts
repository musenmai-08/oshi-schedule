import { createContainer } from './container.js';
import { loadEnv } from './infrastructure/env.js';

export function createRuntime() {
  const env = loadEnv();
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
