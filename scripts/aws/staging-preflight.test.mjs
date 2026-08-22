import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evaluatePreflight,
  formatPreflight,
  parsePreflightArguments,
  resolvePreflightPurpose,
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
  amplify: {
    state: 'DEPLOYED',
    repositoryState: 'DISCONNECTED',
    branchCount: 1,
    mainBranch: { state: 'DEPLOYED', enableAutoBuild: false },
    domainCount: 1,
    domain: { state: 'AVAILABLE', stagingSubdomainVerified: true },
  },
});

const inputs = (status = runningStatus()) => ({
  purpose: 'amplify-manual',
  identity: { Account: '741448960817' },
  region: 'ap-northeast-1',
  gitClean: true,
  status,
  configuredAmplifyPhase: 'manual',
});

describe('staging preflight arguments', () => {
  it('defaults to the next Amplify handoff', () => {
    assert.equal(parsePreflightArguments([]), 'amplify-configured');
    assert.equal(parsePreflightArguments(['--amplify']), 'amplify-configured');
    assert.equal(
      resolvePreflightPurpose('amplify-configured', 'domain-detached'),
      'amplify-domain-detached',
    );
  });

  it('supports every explicit Amplify migration checkpoint', () => {
    for (const phase of [
      'manual',
      'to-domain-detached',
      'domain-detached',
      'to-detached',
      'detached',
      'repository-connected',
      'to-connected',
      'connected',
      'control-plane',
    ]) {
      assert.equal(parsePreflightArguments([`--amplify-${phase}`]), `amplify-${phase}`);
    }
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
    assert.equal(checks.length, 16);
    assert.equal(
      checks.every(({ ok }) => ok),
      true,
    );
    assert.match(
      formatPreflight({ purpose: 'amplify-manual', checks, ok: true }),
      /Preflight passed/,
    );
  });

  it('passes every staged Amplify migration contract', () => {
    const cases = [
      ['amplify-manual', 'manual', 'DISCONNECTED', true, true],
      ['amplify-to-domain-detached', 'domain-detached', 'DISCONNECTED', true, true],
      ['amplify-domain-detached', 'domain-detached', 'DISCONNECTED', true, false],
      ['amplify-to-detached', 'detached', 'DISCONNECTED', true, false],
      ['amplify-detached', 'detached', 'DISCONNECTED', false, false],
      ['amplify-repository-connected', 'detached', 'CONNECTED', false, false],
      ['amplify-to-connected', 'connected', 'CONNECTED', false, false],
      ['amplify-connected', 'connected', 'CONNECTED', true, true],
    ];
    for (const [
      purpose,
      configuredAmplifyPhase,
      repositoryState,
      branchPresent,
      domainPresent,
    ] of cases) {
      const status = runningStatus();
      status.amplify.repositoryState = repositoryState;
      status.amplify.branchCount = branchPresent ? 1 : 0;
      status.amplify.mainBranch = branchPresent
        ? { state: 'DEPLOYED', enableAutoBuild: false }
        : { state: 'NOT_DEPLOYED' };
      status.amplify.domainCount = domainPresent ? 1 : 0;
      status.amplify.domain = domainPresent
        ? { state: 'AVAILABLE', stagingSubdomainVerified: true }
        : { state: 'NOT_DEPLOYED', stagingSubdomainVerified: false };
      const checks = evaluatePreflight({
        ...inputs(status),
        purpose,
        configuredAmplifyPhase,
      });
      assert.equal(
        checks.every(({ ok }) => ok),
        true,
        purpose,
      );
    }
  });

  it('checks only the Amplify control plane when runtime is sleeping and the deadline expired', () => {
    const status = runningStatus();
    status.api = { desiredCount: 0, runningCount: 0, pendingCount: 0 };
    status.rds.state = 'stopped';
    status.syncJobs.desiredState = 'STOPPED';
    status.syncJobs.state = 'STOPPED';
    status.autoSleep.state = 'EXPIRED';
    status.amplify.repositoryState = 'CONNECTED';
    const checks = evaluatePreflight({
      ...inputs(status),
      purpose: 'amplify-control-plane',
      configuredAmplifyPhase: 'connected',
    });

    assert.equal(
      checks.every(({ ok }) => ok),
      true,
    );
    for (const omitted of [
      'Application activation',
      'API desired/running/pending',
      'RDS',
      'Pipe desired state',
      'Pipe current state',
      'Worker Scheduler',
      'Queue visible/in-flight/delayed',
      'Wake deadline',
    ]) {
      assert.equal(
        checks.some(({ name }) => name === omitted),
        false,
        omitted,
      );
    }
  });

  it('rejects a repository state or configured phase from another checkpoint', () => {
    const value = inputs();
    value.status.amplify.repositoryState = 'CONNECTED';
    value.configuredAmplifyPhase = 'detached';
    const checks = evaluatePreflight(value);
    assert.equal(checks.find(({ name }) => name === 'Configured Amplify phase')?.ok, false);
    assert.equal(checks.find(({ name }) => name === 'Amplify repository')?.ok, false);
  });

  it('rejects skipping directly from manual to detached', () => {
    const checks = evaluatePreflight({
      ...inputs(),
      purpose: 'amplify-to-detached',
      configuredAmplifyPhase: 'detached',
    });
    assert.equal(checks.find(({ name }) => name === 'Amplify domains/status/verified')?.ok, false);
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
