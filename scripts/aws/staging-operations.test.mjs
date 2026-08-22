import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AwsCommandError,
  STAGING,
  assertStagingGuard,
  collectStatus,
  formatStatus,
  parseCommandArguments,
  sleepStaging,
  validateTarget,
  wakeStaging,
} from './staging-operations.mjs';

const fullOutputs = [
  ['EnvironmentName', 'staging'],
  ['EcsClusterName', 'staging-cluster'],
  ['ApiServiceName', 'staging-api'],
  ['RdsInstanceIdentifier', 'staging-mysql'],
  ['WorkerScheduleName', 'staging-worker'],
  ['WakeExpiresAtParameterName', '/oshi-schedule-staging/runtime/wake-expires-at'],
  ['ApplicationActivationParameterName', '/oshi-schedule-staging/runtime/application-activated'],
  ['HttpApiId', 'http-api-id'],
  ['VpcLinkId', 'vpc-link-id'],
  ['CloudMapNamespaceId', 'namespace-id'],
  ['CloudMapServiceId', 'service-id'],
  ['SyncJobQueueUrl', 'https://sqs.example.invalid/queue'],
  ['SyncJobPipeName', 'sync-pipe'],
  ['AmplifyAppId', 'app-id'],
  ['ApiUrl', 'https://api-staging.example.invalid'],
  ['WebUrl', 'https://staging.example.invalid'],
].map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue }));

class FakeAws {
  constructor({
    deployed = true,
    outputs = fullOutputs,
    stackStatus = 'CREATE_COMPLETE',
    api = {},
    rds = 'available',
    scheduler = 'DISABLED',
    deadline = '2099-01-01T00:00:00.000Z',
    applicationActivated = true,
    pipe = 'RUNNING',
    amplifyRepository = '',
    amplifyBranches = [{ branchName: 'main', enableAutoBuild: false, totalNumberOfJobs: '0' }],
    amplifyDomains = [
      {
        domainName: 'oshi-schedule.com',
        domainStatus: 'AVAILABLE',
        subDomains: [
          {
            subDomainSetting: { prefix: 'staging', branchName: 'main' },
            verified: true,
          },
        ],
      },
    ],
    failOn,
  } = {}) {
    this.deployed = deployed;
    this.outputs = outputs;
    this.stackStatus = stackStatus;
    this.api = { desiredCount: 1, runningCount: 1, pendingCount: 0, status: 'ACTIVE', ...api };
    this.rds = rds;
    this.scheduler = scheduler;
    this.deadline = deadline;
    this.applicationActivated = applicationActivated;
    this.pipe = pipe;
    this.amplifyRepository = amplifyRepository;
    this.amplifyBranches = amplifyBranches;
    this.amplifyDomains = amplifyDomains;
    this.failOn = failOn;
    this.calls = [];
  }

  async text(args) {
    this.calls.push(args);
    if (args[0] === 'configure') return STAGING.region;
    throw new Error(`Unexpected text command: ${args.join(' ')}`);
  }

  async json(args) {
    this.calls.push(args);
    const operation = `${args[0]} ${args[1]}`;
    if (this.failOn === operation)
      throw new AwsCommandError(`failed: ${operation}`, 'simulated failure');
    switch (operation) {
      case 'sts get-caller-identity':
        return { Account: STAGING.accountId };
      case 'cloudformation describe-stacks':
        if (!this.deployed)
          throw new AwsCommandError('missing', 'ValidationError: stack does not exist');
        return { Stacks: [{ StackStatus: this.stackStatus, Outputs: this.outputs }] };
      case 'ecs describe-services':
        return {
          services: [
            {
              ...this.api,
              taskDefinition: 'task-definition',
              deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED' }],
            },
          ],
          failures: [],
        };
      case 'ecs describe-task-definition':
        return {
          taskDefinition: { containerDefinitions: [{ name: 'api', image: 'repo@sha256:abc' }] },
        };
      case 'ecs update-service': {
        const desired = Number(args[args.indexOf('--desired-count') + 1]);
        this.api.desiredCount = desired;
        this.api.runningCount = desired;
        this.api.pendingCount = 0;
        return { service: this.api };
      }
      case 'rds describe-db-instances':
        return { DBInstances: [{ DBInstanceStatus: this.rds }] };
      case 'rds start-db-instance':
        this.rds = 'available';
        return {};
      case 'rds stop-db-instance':
        this.rds = 'stopped';
        return {};
      case 'scheduler get-schedule':
        return {
          Name: 'staging-worker',
          State: this.scheduler,
          ScheduleExpression: 'rate(1 hour)',
          FlexibleTimeWindow: { Mode: 'OFF' },
          Target: { Arn: 'cluster', RoleArn: 'role' },
        };
      case 'scheduler update-schedule':
        this.scheduler = JSON.parse(args[args.indexOf('--cli-input-json') + 1]).State;
        return {};
      case 'ssm get-parameter':
        if (args[args.indexOf('--name') + 1].endsWith('/application-activated')) {
          return { Parameter: { Value: String(this.applicationActivated) } };
        }
        if (this.deadline === undefined) {
          throw new AwsCommandError('missing', 'ParameterNotFound');
        }
        return { Parameter: { Value: this.deadline } };
      case 'ssm put-parameter':
        this.deadline = args[args.indexOf('--value') + 1];
        return { Version: 2 };
      case 'apigatewayv2 get-api':
        return { ApiId: 'http-api-id', ProtocolType: 'HTTP' };
      case 'apigatewayv2 get-vpc-link':
        return { VpcLinkStatus: 'AVAILABLE' };
      case 'servicediscovery get-namespace':
        return { Namespace: { Id: 'namespace-id' } };
      case 'servicediscovery get-service':
        return { Service: { Id: 'service-id' } };
      case 'servicediscovery list-instances':
        return { Instances: this.api.desiredCount === 1 ? [{ Id: 'task' }] : [] };
      case 'sqs get-queue-attributes':
        return {
          Attributes: {
            ApproximateNumberOfMessages: '0',
            ApproximateNumberOfMessagesNotVisible: '0',
            ApproximateNumberOfMessagesDelayed: '0',
          },
        };
      case 'pipes describe-pipe':
        return { DesiredState: this.pipe, CurrentState: this.pipe };
      case 'amplify get-app':
        return { app: { appId: 'app-id', repository: this.amplifyRepository } };
      case 'amplify list-branches':
        return { branches: this.amplifyBranches };
      case 'amplify list-domain-associations':
        return { domainAssociations: this.amplifyDomains };
      default:
        throw new Error(`Unexpected JSON command: ${args.join(' ')}`);
    }
  }
}

const immediate = async () => {};
const healthyFetch = async () => ({ ok: true });
const fixedNow = new Date('2026-08-12T09:00:00.000Z');
const runtime = { delay: immediate, pollMs: 0, fetchImpl: healthyFetch, now: () => fixedNow };
const called = (aws, operation) => aws.calls.some((args) => `${args[0]} ${args[1]}` === operation);

describe('staging safety guards', () => {
  it('accepts the exact account, region, profile, and staging target', async () => {
    await assert.doesNotReject(assertStagingGuard(new FakeAws()));
  });

  it('rejects the wrong account', async () => {
    const aws = new FakeAws();
    aws.json = async (args) => (args[0] === 'sts' ? { Account: '000000000000' } : {});
    await assert.rejects(assertStagingGuard(aws), /account guard/);
  });

  it('rejects the wrong region', async () => {
    const aws = new FakeAws();
    aws.text = async () => 'us-east-1';
    await assert.rejects(assertStagingGuard(aws), /region guard/);
  });

  it('rejects another profile and production target', () => {
    assert.throws(() => validateTarget({ ...STAGING, profile: 'default' }), /unsafe/);
    assert.throws(
      () =>
        validateTarget({
          ...STAGING,
          environment: 'production',
          stackName: 'oshi-schedule-production',
        }),
      /unsafe/,
    );
  });
});

describe('staging status', () => {
  it('reports NOT_DEPLOYED when the stack is absent', async () => {
    assert.equal((await collectStatus(new FakeAws({ deployed: false }))).overall, 'NOT_DEPLOYED');
  });

  it('reports NOT_DEPLOYED for the existing bootstrap-only stack', async () => {
    const outputs = [
      { OutputKey: 'EnvironmentName', OutputValue: 'staging' },
      { OutputKey: 'EcrRepositoryUri', OutputValue: 'repository' },
    ];
    assert.equal((await collectStatus(new FakeAws({ outputs }))).overall, 'NOT_DEPLOYED');
  });

  it('reports RUNNING', async () => {
    assert.equal((await collectStatus(new FakeAws())).overall, 'RUNNING');
  });

  it('reports the manual Amplify connection checkpoint without exposing repository values', async () => {
    const status = await collectStatus(new FakeAws());
    assert.deepEqual(status.amplify, {
      state: 'DEPLOYED',
      repositoryState: 'DISCONNECTED',
      branchCount: 1,
      mainBranch: { state: 'DEPLOYED', enableAutoBuild: false, totalNumberOfJobs: 0 },
      domainCount: 1,
      domain: {
        state: 'AVAILABLE',
        updateState: undefined,
        stagingSubdomainVerified: true,
      },
    });
    assert.doesNotMatch(formatStatus(status), /github\.com/);
  });

  it('reports detached and repository-connected Amplify checkpoints', async () => {
    const detached = await collectStatus(new FakeAws({ amplifyBranches: [], amplifyDomains: [] }));
    assert.equal(detached.amplify.repositoryState, 'DISCONNECTED');
    assert.equal(detached.amplify.branchCount, 0);
    assert.equal(detached.amplify.domainCount, 0);

    const connected = await collectStatus(
      new FakeAws({
        amplifyRepository: STAGING.repository,
        amplifyBranches: [],
        amplifyDomains: [],
      }),
    );
    assert.equal(connected.amplify.repositoryState, 'CONNECTED');
  });

  it('reports SLEEPING', async () => {
    const aws = new FakeAws({ api: { desiredCount: 0, runningCount: 0 }, rds: 'stopped' });
    assert.equal((await collectStatus(aws)).overall, 'SLEEPING');
  });

  it('reports NOT_STARTED for the migration-safe Phase 1 state', async () => {
    const aws = new FakeAws({
      applicationActivated: false,
      api: { desiredCount: 0, runningCount: 0 },
      rds: 'available',
      pipe: 'STOPPED',
    });
    const status = await collectStatus(aws);
    assert.equal(status.overall, 'NOT_STARTED');
    assert.equal(status.applicationActivation.state, 'NOT_READY');
    assert.match(formatStatus(status), /Application activation: NOT_READY/);
    assert.match(formatStatus(status), /API: NOT_STARTED/);
  });

  it('reports PARTIAL for inconsistent core state', async () => {
    const aws = new FakeAws({ api: { desiredCount: 0, runningCount: 0 }, rds: 'available' });
    assert.equal((await collectStatus(aws)).overall, 'PARTIAL');
  });

  it('formats an active deadline in JST with the remaining duration', async () => {
    const aws = new FakeAws({ deadline: '2026-08-12T13:00:00.000Z' });
    const status = await collectStatus(aws, { now: fixedNow });
    const output = formatStatus(status);
    assert.match(output, /Expires at: 2026-08-12 22:00 JST/);
    assert.match(output, /Remaining: 4h 0m/);
  });
});

describe('staging sleep', () => {
  it('disables Scheduler, scales ECS to zero, and stops RDS in order', async () => {
    const aws = new FakeAws({ scheduler: 'ENABLED' });
    const status = await sleepStaging(aws, runtime);
    assert.equal(status.overall, 'SLEEPING');
    const operations = aws.calls.map((args) => `${args[0]} ${args[1]}`);
    assert.ok(
      operations.indexOf('ssm put-parameter') < operations.indexOf('scheduler update-schedule'),
    );
    assert.ok(
      operations.indexOf('scheduler update-schedule') < operations.indexOf('ecs update-service'),
    );
    assert.ok(
      operations.indexOf('ecs update-service') < operations.indexOf('rds stop-db-instance'),
    );
    assert.equal(aws.deadline, fixedNow.toISOString());
  });

  it('is idempotent when already sleeping and Scheduler is disabled', async () => {
    const aws = new FakeAws({ api: { desiredCount: 0, runningCount: 0 }, rds: 'stopped' });
    assert.equal((await sleepStaging(aws, runtime)).overall, 'SLEEPING');
    assert.equal(called(aws, 'scheduler update-schedule'), false);
    assert.equal(called(aws, 'ecs update-service'), false);
    assert.equal(called(aws, 'rds stop-db-instance'), false);
  });

  it('surfaces an intermediate RDS failure without restarting ECS', async () => {
    const aws = new FakeAws({ failOn: 'rds stop-db-instance' });
    await assert.rejects(sleepStaging(aws, runtime), /failed/);
    assert.equal(aws.api.desiredCount, 0);
    assert.equal(called(aws, 'rds stop-db-instance'), true);
  });

  it('refuses a non-staging CloudFormation output before any write', async () => {
    const outputs = fullOutputs.map((output) =>
      output.OutputKey === 'EnvironmentName' ? { ...output, OutputValue: 'production' } : output,
    );
    const aws = new FakeAws({ outputs });
    await assert.rejects(sleepStaging(aws, runtime), /environment guard/);
    assert.equal(called(aws, 'ecs update-service'), false);
    assert.equal(called(aws, 'rds stop-db-instance'), false);
  });

  it('refuses a CloudFormation stack update in progress before any write', async () => {
    const aws = new FakeAws({ stackStatus: 'UPDATE_IN_PROGRESS' });
    await assert.rejects(sleepStaging(aws, runtime), /not stable/);
    assert.equal(called(aws, 'scheduler update-schedule'), false);
  });
});

describe('staging wake', () => {
  it('rejects before any AWS write when migration activation is not ready', async () => {
    const aws = new FakeAws({
      applicationActivated: false,
      api: { desiredCount: 0, runningCount: 0 },
      rds: 'available',
      pipe: 'STOPPED',
    });
    await assert.rejects(wakeStaging(aws, runtime), /not activated yet/);
    for (const operation of [
      'ssm put-parameter',
      'scheduler update-schedule',
      'rds start-db-instance',
      'ecs update-service',
    ]) {
      assert.equal(called(aws, operation), false);
    }
  });

  it('starts RDS, scales ECS to one, waits for health and ready, and leaves Scheduler disabled', async () => {
    const urls = [];
    const aws = new FakeAws({ api: { desiredCount: 0, runningCount: 0 }, rds: 'stopped' });
    const status = await wakeStaging(aws, {
      ...runtime,
      fetchImpl: async (url) => {
        urls.push(url);
        return { ok: true };
      },
    });
    assert.equal(status.overall, 'RUNNING');
    assert.deepEqual(urls, [
      'https://api-staging.example.invalid/health',
      'https://api-staging.example.invalid/ready',
    ]);
    assert.equal(aws.scheduler, 'DISABLED');
    const operations = aws.calls.map((args) => `${args[0]} ${args[1]}`);
    assert.ok(
      operations.indexOf('ssm put-parameter') < operations.indexOf('rds start-db-instance'),
    );
    assert.ok(
      operations.indexOf('rds start-db-instance') < operations.indexOf('ecs update-service'),
    );
  });

  it('does not start ECS if RDS start fails', async () => {
    const aws = new FakeAws({
      api: { desiredCount: 0, runningCount: 0 },
      rds: 'stopped',
      failOn: 'rds start-db-instance',
    });
    await assert.rejects(wakeStaging(aws, runtime), /failed/);
    assert.equal(called(aws, 'ecs update-service'), false);
    assert.equal(aws.deadline, '2026-08-12T13:00:00.000Z');
  });

  it('reports readiness failure without rolling resources back to sleep', async () => {
    const aws = new FakeAws({ api: { desiredCount: 0, runningCount: 0 }, rds: 'stopped' });
    await assert.rejects(
      wakeStaging(aws, {
        ...runtime,
        readinessTimeoutMs: 0,
        fetchImpl: async () => ({ ok: false }),
      }),
      /readiness timed out/,
    );
    assert.equal(aws.rds, 'available');
    assert.equal(aws.api.desiredCount, 1);
  });

  it('replaces the deadline from the current time when wake extends usage', async () => {
    const aws = new FakeAws({ deadline: '2026-08-12T10:00:00.000Z' });
    await wakeStaging(aws, { ...runtime, hours: 8 });
    assert.equal(aws.deadline, '2026-08-12T17:00:00.000Z');
  });
});

describe('wake hours CLI', () => {
  it('defaults to four hours', () => {
    assert.deepEqual(parseCommandArguments('wake', []), { hours: 4 });
  });

  for (const hours of ['1', '4', '24']) {
    it(`accepts ${hours} hours`, () => {
      assert.deepEqual(parseCommandArguments('wake', ['--hours', hours]), {
        hours: Number(hours),
      });
    });
  }

  for (const hours of ['0', '-1', '25', 'abc', '1.5']) {
    it(`rejects invalid hours ${hours}`, () => {
      assert.throws(() => parseCommandArguments('wake', ['--hours', hours]), /integer between/);
    });
  }
});
