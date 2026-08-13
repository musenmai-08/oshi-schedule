import { App } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import {
  loadConfig,
  parseBooleanContext,
  parseNonNegativeIntegerContext,
  parseSyncPipeDesiredState,
} from '../lib/config.js';

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

describe('parseNonNegativeIntegerContext', () => {
  it.each([
    [0, 0],
    ['0', 0],
    [1, 1],
    ['1', 1],
    [2, 2],
  ] as const)('parses %j as %j', (value, expected) => {
    expect(parseNonNegativeIntegerContext('apiDesiredCount', value, 0)).toBe(expected);
  });

  it.each([-1, '-1', 1.5, '1.5', 'invalid', Number.NaN, '', null])(
    'rejects invalid value %j',
    (value) => {
      expect(() => parseNonNegativeIntegerContext('apiDesiredCount', value, 0)).toThrow(
        'CDK context apiDesiredCount must be a non-negative integer',
      );
    },
  );
});

describe('parseSyncPipeDesiredState', () => {
  it.each(['STOPPED', 'RUNNING'] as const)('accepts %s', (value) => {
    expect(parseSyncPipeDesiredState(value, 'STOPPED')).toBe(value);
  });

  it.each(['stopped', 'running', 'STARTED', '', true, 1, null])('rejects %j', (value) => {
    expect(() => parseSyncPipeDesiredState(value, 'STOPPED')).toThrow(
      'CDK context syncPipeDesiredState must be STOPPED or RUNNING',
    );
  });
});

describe('loadConfig', () => {
  it('synthesizes staging without a purchased domain', () => {
    const app = new App({ context: { environment: 'staging' } });
    const config = loadConfig(app);
    expect(config.deployReady).toBe(false);
    expect(config.bootstrapOnly).toBe(false);
    expect(config.apiDesiredCount).toBe(0);
    expect(config.syncPipeDesiredState).toBe('STOPPED');
    expect(config.applicationActivated).toBe(false);
    expect(config.webDomainName).toBeUndefined();
    expect(config.monthlyBudgetUsd).toBe(25);
  });

  it('does not apply the staging budget default to production', () => {
    const app = new App({
      context: { environment: 'production', confirmProduction: 'DEPLOY_PRODUCTION' },
    });
    expect(loadConfig(app)).toMatchObject({
      monthlyBudgetUsd: 75,
      apiDesiredCount: 1,
      syncPipeDesiredState: 'RUNNING',
      applicationActivated: true,
    });
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

  it('rejects application activation bypasses outside bootstrap-only mode', () => {
    expect(() =>
      loadConfig(
        new App({
          context: {
            environment: 'staging',
            apiDesiredCount: 1,
            syncPipeDesiredState: 'STOPPED',
            applicationActivated: false,
          },
        }),
      ),
    ).toThrow(/applicationActivated=false requires/);
    expect(() =>
      loadConfig(
        new App({
          context: {
            environment: 'staging',
            apiDesiredCount: 0,
            syncPipeDesiredState: 'RUNNING',
            applicationActivated: false,
          },
        }),
      ),
    ).toThrow(/applicationActivated=false requires/);
  });

  it('does not require full rollout state for bootstrap-only synth', () => {
    const config = loadConfig(
      new App({
        context: {
          environment: 'staging',
          bootstrapOnly: true,
          apiDesiredCount: 2,
          syncPipeDesiredState: 'RUNNING',
          applicationActivated: false,
        },
      }),
    );
    expect(config.bootstrapOnly).toBe(true);
  });
});
