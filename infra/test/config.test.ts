import { App } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseBooleanContext } from '../lib/config.js';

describe('parseBooleanContext', () => {
  it.each([
    [true, false, true],
    ['true', false, true],
    [false, true, false],
    ['false', true, false],
    [undefined, true, true],
    [undefined, false, false],
  ] as const)('parses %j with default %j as %j', (value, defaultValue, expected) => {
    expect(parseBooleanContext('testFlag', value, defaultValue)).toBe(expected);
  });

  it.each(['TRUE', 'yes', '1', '', 'abc', 0, 1, null])('rejects invalid value %j', (value) => {
    expect(() => parseBooleanContext('testFlag', value, false)).toThrow(
      'CDK context testFlag must be true or false',
    );
  });
});

describe('loadConfig', () => {
  it('synthesizes staging without a purchased domain', () => {
    const app = new App({ context: { environment: 'staging' } });
    const config = loadConfig(app);
    expect(config.deployReady).toBe(false);
    expect(config.bootstrapOnly).toBe(false);
    expect(config.webDomainName).toBeUndefined();
    expect(config.monthlyBudgetUsd).toBe(40);
  });

  it('does not apply the staging budget default to production', () => {
    const app = new App({
      context: { environment: 'production', confirmProduction: 'DEPLOY_PRODUCTION' },
    });
    expect(loadConfig(app).monthlyBudgetUsd).toBe(75);
  });

  it('supports an explicit environment budget override', () => {
    const app = new App({
      context: { environment: 'staging', monthlyBudgetUsd: 45 },
    });
    expect(loadConfig(app).monthlyBudgetUsd).toBe(45);
  });

  it('rejects deployReady when mandatory deployment inputs are absent', () => {
    const app = new App({ context: { environment: 'staging', deployReady: 'true' } });
    expect(() => loadConfig(app)).toThrow(/requires context/);
  });

  it('keeps synth-only behavior when deployReady is the CLI string false', () => {
    const app = new App({ context: { environment: 'staging', deployReady: 'false' } });
    expect(loadConfig(app).deployReady).toBe(false);
  });

  it('parses CLI boolean strings for bootstrap, RDS, and worker settings', () => {
    const app = new App({
      context: {
        environment: 'staging',
        deployReady: 'true',
        bootstrapOnly: 'true',
        awsAccount: '111111111111',
        rdsMultiAz: 'true',
        rdsDeletionProtection: 'false',
        workerScheduleEnabled: 'true',
      },
    });
    expect(loadConfig(app)).toMatchObject({
      deployReady: true,
      bootstrapOnly: true,
      rdsMultiAz: true,
      rdsDeletionProtection: false,
      workerScheduleEnabled: true,
    });
  });

  it('requires an explicit production acknowledgement', () => {
    const app = new App({ context: { environment: 'production' } });
    expect(() => loadConfig(app)).toThrow(/confirmProduction=DEPLOY_PRODUCTION/);
  });
});
