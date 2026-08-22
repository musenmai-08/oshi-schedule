import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  calculateWakeDeadline,
  formatDeadlineJst,
  formatRemaining,
  inspectWakeDeadline,
} from './staging-auto-sleep/deadline.mjs';
import {
  ecsDescribeServicesInput,
  ecsUpdateServiceInput,
  runAutoSleep,
} from './staging-auto-sleep/index.mjs';

const settings = Object.freeze({
  TARGET_ENVIRONMENT: 'staging',
  EXPECTED_ACCOUNT_ID: '741448960817',
  DEADLINE_PARAMETER_NAME: '/oshi-schedule-staging/runtime/wake-expires-at',
  WORKER_SCHEDULE_NAME: 'oshi-schedule-staging-hourly-worker',
  ECS_CLUSTER_NAME: 'oshi-schedule-staging-cluster',
  ECS_API_SERVICE_NAME: 'oshi-schedule-staging-api',
  RDS_INSTANCE_IDENTIFIER: 'oshi-schedule-staging-mysql',
});
const now = new Date('2026-08-12T09:00:00.000Z');

class FakeAws {
  constructor({
    deadline = '2026-08-12T08:00:00.000Z',
    schedule = 'ENABLED',
    desiredCount = 1,
    runningCount = 1,
    database = 'available',
    account = settings.EXPECTED_ACCOUNT_ID,
    failOn,
  } = {}) {
    this.deadline = deadline;
    this.schedule = schedule;
    this.desiredCount = desiredCount;
    this.runningCount = runningCount;
    this.database = database;
    this.account = account;
    this.failOn = failOn;
    this.calls = [];
  }

  call(name) {
    this.calls.push(name);
    if (this.failOn === name) throw new Error(`simulated ${name} failure`);
  }

  async getCallerIdentity() {
    this.call('getCallerIdentity');
    return { Account: this.account };
  }

  async getParameter() {
    this.call('getParameter');
    return this.deadline;
  }

  async getSchedule(name) {
    this.call('getSchedule');
    return {
      Name: name,
      State: this.schedule,
      ScheduleExpression: 'rate(1 hour)',
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: { Arn: 'target', RoleArn: 'role' },
    };
  }

  async updateSchedule(input) {
    this.call('updateSchedule');
    this.schedule = input.State;
  }

  async describeService() {
    this.call('describeService');
    return {
      clusterArn: 'cluster',
      serviceArn: 'service',
      desiredCount: this.desiredCount,
      runningCount: this.runningCount,
    };
  }

  async updateService(_cluster, _service, desiredCount) {
    this.call('updateService');
    this.desiredCount = desiredCount;
  }

  async describeDatabase() {
    this.call('describeDatabase');
    return { DBInstanceStatus: this.database };
  }

  async stopDatabase() {
    this.call('stopDatabase');
    this.database = 'stopping';
  }
}

const run = (aws, overrides = {}) => {
  const events = [];
  return runAutoSleep({
    aws,
    settings: { ...settings, ...overrides },
    now,
    log: (entry) => events.push(JSON.parse(entry)),
  }).then((result) => ({ result, events }));
};

describe('wake deadline', () => {
  it('calculates the deadline in UTC without depending on the OS timezone', () => {
    assert.equal(calculateWakeDeadline(4, now), '2026-08-12T13:00:00.000Z');
  });

  it('formats the UTC deadline in JST', () => {
    assert.equal(formatDeadlineJst('2026-08-12T13:00:00.000Z'), '2026-08-12 22:00 JST');
  });

  it('formats remaining time and identifies expiration', () => {
    const active = inspectWakeDeadline('2026-08-12T12:14:01.000Z', now);
    assert.equal(active.state, 'ACTIVE');
    assert.equal(formatRemaining(active.remainingMs), '3h 15m');
    assert.equal(inspectWakeDeadline(now.toISOString(), now).state, 'EXPIRED');
  });
});

describe('staging auto sleep Lambda', () => {
  it('uses the lower camel case input names required by the ECS SDK', () => {
    assert.deepEqual(ecsDescribeServicesInput('cluster', 'service'), {
      cluster: 'cluster',
      services: ['service'],
    });
    assert.deepEqual(ecsUpdateServiceInput('cluster', 'service', 0), {
      cluster: 'cluster',
      service: 'service',
      desiredCount: 0,
    });
  });

  it('does nothing while the deadline is in the future', async () => {
    const aws = new FakeAws({ deadline: '2026-08-12T10:00:00.000Z' });
    const { result } = await run(aws);
    assert.equal(result.outcome, 'NOOP_ACTIVE');
    assert.equal(aws.calls.includes('updateService'), false);
  });

  it('sleeps expired staging resources in safe order', async () => {
    const aws = new FakeAws();
    const { result } = await run(aws);
    assert.equal(result.outcome, 'AUTO_SLEEP_TRIGGERED');
    assert.equal(aws.schedule, 'DISABLED');
    assert.equal(aws.desiredCount, 0);
    assert.equal(aws.database, 'stopping');
    assert.ok(aws.calls.indexOf('updateSchedule') < aws.calls.indexOf('updateService'));
    assert.ok(aws.calls.indexOf('updateService') < aws.calls.indexOf('stopDatabase'));
  });

  it('does not update an already disabled Worker Scheduler', async () => {
    const aws = new FakeAws({ schedule: 'DISABLED' });
    await run(aws);
    assert.equal(aws.calls.includes('updateSchedule'), false);
  });

  it('does not update ECS when desiredCount is already zero', async () => {
    const aws = new FakeAws({ desiredCount: 0, runningCount: 0 });
    await run(aws);
    assert.equal(aws.calls.includes('updateService'), false);
  });

  it('does not stop an already stopped database', async () => {
    const aws = new FakeAws({ database: 'stopped' });
    await run(aws);
    assert.equal(aws.calls.includes('stopDatabase'), false);
  });

  it('returns already sleeping when every resource is safe', async () => {
    const aws = new FakeAws({
      schedule: 'DISABLED',
      desiredCount: 0,
      runningCount: 0,
      database: 'stopped',
    });
    const { result } = await run(aws);
    assert.equal(result.outcome, 'NOOP_ALREADY_SLEEPING');
  });

  it('stops an available database after the deadline', async () => {
    const aws = new FakeAws({ schedule: 'DISABLED', desiredCount: 0, runningCount: 0 });
    await run(aws);
    assert.equal(aws.calls.includes('stopDatabase'), true);
  });

  it('reports a partial RDS failure without rolling back completed safe operations', async () => {
    const aws = new FakeAws({ failOn: 'stopDatabase' });
    const events = [];
    await assert.rejects(
      runAutoSleep({
        aws,
        settings,
        now,
        log: (entry) => events.push(JSON.parse(entry)),
      }),
      /incomplete/,
    );
    assert.equal(aws.calls.includes('updateService'), true);
    assert.equal(aws.calls.includes('stopDatabase'), true);
    assert.equal(events.at(-1).event, 'AUTO_SLEEP_PARTIAL');
  });

  it('rejects a malformed deadline', async () => {
    await assert.rejects(run(new FakeAws({ deadline: 'tomorrow' })), /malformed/);
  });

  it('does nothing when the deadline parameter has no value', async () => {
    const aws = new FakeAws();
    aws.deadline = undefined;
    const { result } = await run(aws);
    assert.equal(result.outcome, 'NOOP_NO_DEADLINE');
  });

  it('rejects production before reading or changing resources', async () => {
    const aws = new FakeAws();
    await assert.rejects(run(aws, { TARGET_ENVIRONMENT: 'production' }), /restricted to staging/);
    assert.deepEqual(aws.calls, []);
  });

  it('rejects execution in another AWS account', async () => {
    const aws = new FakeAws({ account: '000000000000' });
    await assert.rejects(run(aws), /identity guard/);
    assert.equal(aws.calls.includes('getParameter'), false);
  });
});
