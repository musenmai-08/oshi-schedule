import { configure as serverlessExpress } from '@codegenie/serverless-express';
import type { Handler } from 'aws-lambda';
import { createApp } from './app.js';
import { createContainer } from './container.js';
import { loadEnv } from './infrastructure/env.js';
import { loadLambdaRuntimeEnvironment } from './infrastructure/lambda/runtime-env.js';

type LambdaProxy = Handler<Record<string, unknown>, unknown>;

export const createApiLambdaHandler = (
  source: NodeJS.ProcessEnv = process.env,
): LambdaProxy => {
  const env = loadEnv(source, 'api');
  const container = createContainer(env);
  return serverlessExpress({ app: createApp(env, container) }) as LambdaProxy;
};

let proxy: Promise<LambdaProxy> | undefined;

const bootstrap = async () => {
  await loadLambdaRuntimeEnvironment('api');
  return createApiLambdaHandler();
};

export const handler: LambdaProxy = async (event, context, callback) => {
  proxy ??= bootstrap();
  try {
    return await (await proxy)(event, context, callback);
  } catch (error) {
    proxy = undefined;
    throw error;
  }
};
