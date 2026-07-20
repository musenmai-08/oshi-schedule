import { createApp } from './app.js';
import { createContainer } from './container.js';
import { loadEnv } from './infrastructure/env.js';
import { logger } from './infrastructure/logging/logger.js';

const env = loadEnv();
const app = createApp(env, createContainer(env));
app.listen(env.PORT, () => logger.info({ port: env.PORT, mode: env.APP_MODE }, 'api started'));
