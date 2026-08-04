import { createContainer } from './container.js';
import { loadEnv } from './infrastructure/env.js';

export function createRuntime() {
  const env = loadEnv();
  const container = createContainer(env);
  return {
    env,
    container,
    runScheduled: () => container.service.sync.runScheduled(),
    disconnect: () => container.resources.disconnect(),
  };
}
