#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { loadConfig } from '../lib/config.js';
import { OshiScheduleStack } from '../lib/oshi-schedule-stack.js';

const app = new App();
const config = loadConfig(app);

new OshiScheduleStack(app, `oshi-schedule-${config.environmentName}`, {
  env: { account: config.account, region: config.region },
  config,
  description: `Oshi Schedule ${config.environmentName} application infrastructure`,
});
