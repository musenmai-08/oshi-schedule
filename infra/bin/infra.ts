#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { loadConfig } from '../lib/config.js';
import { OshiScheduleStack } from '../lib/oshi-schedule-stack.js';
import { ServerlessOshiScheduleStack } from '../lib/serverless-stack.js';

const app = new App();
const config = loadConfig(app);

const StackClass =
  config.runtimeArchitecture === 'serverless' ? ServerlessOshiScheduleStack : OshiScheduleStack;
const stackName =
  config.runtimeArchitecture === 'serverless' &&
  config.environmentName === 'staging' &&
  config.serverlessStagingMode === 'preview'
    ? 'oshi-schedule-staging-serverless'
    : `oshi-schedule-${config.environmentName}`;

new StackClass(app, stackName, {
  env: { account: config.account, region: config.region },
  config,
  description: `Oshi Schedule ${config.environmentName} application infrastructure`,
});
