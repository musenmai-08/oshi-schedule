import { createApp } from './app.js';
import { createContainer } from './container.js';
import { loadEnv } from './infrastructure/env.js';
import { logger } from './infrastructure/logging/logger.js';
import { createShutdownController } from './shutdown.js';

const env = loadEnv();
const container = createContainer(env);
const app = createApp(env, container);
const server = app.listen(env.PORT, () =>
  logger.info({ port: env.PORT, mode: env.APP_MODE }, 'api started'),
);
const shutdown = createShutdownController({
  server,
  disconnect: () => container.resources.disconnect(),
  timeoutMs: env.SHUTDOWN_TIMEOUT_SECONDS * 1_000,
  logger,
  finish: (code, forced) => {
    if (forced) process.exit(code);
    process.exitCode = code;
  },
});

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
