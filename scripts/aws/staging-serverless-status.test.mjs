import assert from 'node:assert/strict';
import test from 'node:test';
import { collectServerlessStatus } from './staging-serverless-status.mjs';

const outputs = [
  ['ApiFunctionName', 'api'],
  ['WorkerFunctionName', 'worker'],
  ['WorkerScheduleName', 'hourly-worker'],
  ['SyncJobQueueUrl', 'https://sqs.example.invalid/sync'],
  ['HttpApiId', 'api-id'],
].map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue }));

test('reports Lambda/Supabase-ready status without consulting legacy ECS or RDS', async () => {
  const requested = [];
  const command = async (args) => {
    requested.push(args);
    const [service, operation] = args;
    if (service === 'cloudformation') return { Stacks: [{ StackStatus: 'UPDATE_COMPLETE', Outputs: outputs }] };
    if (service === 'lambda' && operation === 'get-function-configuration') return { State: 'Active' };
    if (service === 'lambda') return { EventSourceMappings: [{ State: 'Enabled', BatchSize: 1, ScalingConfig: { MaximumConcurrency: 2 } }] };
    if (service === 'scheduler') return { State: 'DISABLED' };
    if (service === 'sqs') return { Attributes: { ApproximateNumberOfMessages: '0', ApproximateNumberOfMessagesNotVisible: '0' } };
    if (service === 'cloudwatch') return { MetricAlarms: [{ AlarmName: 'serverless-alarm', StateValue: 'OK' }] };
    if (service === 'apigatewayv2') return { ApiEndpoint: 'https://preview.example.invalid' };
    throw new Error(`unexpected command: ${args.join(' ')}`);
  };

  const status = await collectServerlessStatus({
    command,
    fetchImpl: async (url) => {
      assert.equal(url, 'https://preview.example.invalid/ready');
      return { ok: true };
    },
  });

  assert.deepEqual(status, {
    stack: 'UPDATE_COMPLETE', api: 'Active', worker: 'Active', ready: true, scheduler: 'DISABLED',
    queue: { visible: 0, inFlight: 0 }, dlq: { visible: 0, inFlight: 0 },
    mapping: { state: 'Enabled', batchSize: 1, maximumConcurrency: 2 },
    alarms: [{ name: 'serverless-alarm', state: 'OK' }],
  });
  assert.equal(requested.some(([service]) => ['ecs', 'rds'].includes(service)), false);
});
