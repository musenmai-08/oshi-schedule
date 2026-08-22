import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evaluatePreflight,
  formatPreflight,
  parsePreflightArguments,
} from './staging-preflight.mjs';

const runningStatus = () => ({
  stack: { state: 'UPDATE_COMPLETE' },
  applicationActivation: { state: 'READY' },
  api: { desiredCount: 1, runningCount: 1, pendingCount: 0 },
  rds: { state: 'available' },
  syncJobs: {
    desiredState: 'RUNNING',
    state: 'RUNNING',
    queuedMessages: 0,
    inFlightMessages: 0,
    delayedMessages: 0,
  },
  scheduler: { state: 'DISABLED' },
  autoSleep: { state: 'ACTIVE' },
});

const inputs = (status = runningStatus()) => ({
  purpose: 'amplify',
  identity: { Account: '741448960817' },
  region: 'ap-northeast-1',
  gitClean: true,
  status,
});

describe('staging preflight arguments', () => {
  it('defaults to the next Amplify handoff', () => {
    assert.equal(parsePreflightArguments([]), 'amplify');
    assert.equal(parsePreflightArguments(['--amplify']), 'amplify');
  });

  it('supports the Phase 2 preparation profile', () => {
    assert.equal(parsePreflightArguments(['--phase2']), 'phase2');
  });

  it('rejects ambiguous or unknown arguments', () => {
    assert.throws(() => parsePreflightArguments(['--unknown']), /Usage/);
    assert.throws(() => parsePreflightArguments(['--amplify', '--phase2']), /Usage/);
  });
});

describe('staging preflight checks', () => {
  it('passes the current Amplify-ready contract', () => {
    const checks = evaluatePreflight(inputs());
    assert.equal(checks.length, 11);
    assert.equal(
      checks.every(({ ok }) => ok),
      true,
    );
    assert.match(formatPreflight({ purpose: 'amplify', checks, ok: true }), /Preflight passed/);
  });

  it('passes the safe Phase 1 contract before Phase 2', () => {
    const status = runningStatus();
    status.applicationActivation.state = 'NOT_READY';
    status.api = { desiredCount: 0, runningCount: 0, pendingCount: 0 };
    status.syncJobs.desiredState = 'STOPPED';
    status.syncJobs.state = 'STOPPED';
    const checks = evaluatePreflight({ ...inputs(status), purpose: 'phase2' });
    assert.equal(
      checks.every(({ ok }) => ok),
      true,
    );
  });

  for (const [name, mutate] of [
    ['wrong account', (value) => (value.identity.Account = '000000000000')],
    ['wrong region', (value) => (value.region = 'us-east-1')],
    ['dirty Git tree', (value) => (value.gitClean = false)],
    ['CloudFormation in progress', (value) => (value.status.stack.state = 'UPDATE_IN_PROGRESS')],
    ['inactive application', (value) => (value.status.applicationActivation.state = 'NOT_READY')],
    ['unstable API', (value) => (value.status.api.pendingCount = 1)],
    ['stopped RDS', (value) => (value.status.rds.state = 'stopped')],
    ['stopped Pipe desired state', (value) => (value.status.syncJobs.desiredState = 'STOPPED')],
    ['stopped Pipe', (value) => (value.status.syncJobs.state = 'STOPPED')],
    ['enabled Worker Scheduler', (value) => (value.status.scheduler.state = 'ENABLED')],
    ['non-empty Queue', (value) => (value.status.syncJobs.inFlightMessages = 1)],
    ['expired deadline', (value) => (value.status.autoSleep.state = 'EXPIRED')],
  ]) {
    it(`fails for ${name}`, () => {
      const value = inputs();
      mutate(value);
      assert.equal(
        evaluatePreflight(value).every(({ ok }) => ok),
        false,
      );
    });
  }
});
