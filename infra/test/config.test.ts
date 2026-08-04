import { App } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../lib/config.js';

describe('loadConfig', () => {
  it('synthesizes staging without a purchased domain', () => {
    const app = new App({ context: { environment: 'staging' } });
    const config = loadConfig(app);
    expect(config.deployReady).toBe(false);
    expect(config.webDomainName).toBeUndefined();
  });

  it('rejects deployReady when mandatory deployment inputs are absent', () => {
    const app = new App({ context: { environment: 'staging', deployReady: true } });
    expect(() => loadConfig(app)).toThrow(/requires context/);
  });

  it('requires an explicit production acknowledgement', () => {
    const app = new App({ context: { environment: 'production' } });
    expect(() => loadConfig(app)).toThrow(/confirmProduction=DEPLOY_PRODUCTION/);
  });
});
