import { inspectWakeDeadline } from './deadline.mjs';
import { schedulerUpdatePayload } from './sleep-core.mjs';
import console from 'node:console';
import process from 'node:process';

const REQUIRED_ENVIRONMENT = 'staging';
const REQUIRED_ACCOUNT_ID = '741448960817';

const emit = (log, event, details = {}) => log(JSON.stringify({ event, ...details }));

const requireSetting = (settings, name) => {
  const value = settings[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing Lambda setting: ${name}`);
  }
  return value;
};

export const ecsDescribeServicesInput = (cluster, service) => ({
  cluster,
  services: [service],
});

export const ecsUpdateServiceInput = (cluster, service, desiredCount) => ({
  cluster,
  service,
  desiredCount,
});

export const runAutoSleep = async ({ aws, settings, now = new Date(), log = console.log }) => {
  const environment = requireSetting(settings, 'TARGET_ENVIRONMENT');
  const expectedAccountId = requireSetting(settings, 'EXPECTED_ACCOUNT_ID');
  if (environment !== REQUIRED_ENVIRONMENT) {
    emit(log, 'AUTO_SLEEP_FAILED', { reason: 'ENVIRONMENT_GUARD' });
    throw new Error('Auto sleep is restricted to staging');
  }
  if (expectedAccountId !== REQUIRED_ACCOUNT_ID) {
    emit(log, 'AUTO_SLEEP_FAILED', { reason: 'ACCOUNT_CONFIGURATION_GUARD' });
    throw new Error('Auto sleep account configuration is unsafe');
  }
  const identity = await aws.getCallerIdentity();
  if (identity.Account !== expectedAccountId) {
    emit(log, 'AUTO_SLEEP_FAILED', { reason: 'ACCOUNT_IDENTITY_GUARD' });
    throw new Error('Auto sleep account identity guard rejected the current account');
  }

  const deadlineValue = await aws.getParameter(requireSetting(settings, 'DEADLINE_PARAMETER_NAME'));
  const deadline = inspectWakeDeadline(deadlineValue, now);
  if (deadline.state === 'UNSET') {
    emit(log, 'NOOP_NO_DEADLINE');
    return { outcome: 'NOOP_NO_DEADLINE' };
  }
  if (deadline.state === 'INVALID') {
    emit(log, 'AUTO_SLEEP_FAILED', { reason: 'MALFORMED_DEADLINE' });
    throw new Error('Wake deadline is malformed');
  }
  if (deadline.state === 'ACTIVE') {
    emit(log, 'NOOP_ACTIVE', { expiresAt: deadline.expiresAt });
    return { outcome: 'NOOP_ACTIVE', expiresAt: deadline.expiresAt };
  }

  let changed = false;
  const attempt = async (operation, callback) => {
    try {
      if (await callback()) changed = true;
    } catch (error) {
      emit(log, 'AUTO_SLEEP_PARTIAL', { failures: [operation] });
      throw new Error(`Auto sleep was incomplete: ${operation}`, { cause: error });
    }
  };

  await attempt('WORKER_SCHEDULER', async () => {
    const name = requireSetting(settings, 'WORKER_SCHEDULE_NAME');
    const schedule = await aws.getSchedule(name);
    if (schedule.State === 'DISABLED') return false;
    await aws.updateSchedule(schedulerUpdatePayload(schedule, 'DISABLED'));
    return true;
  });
  await attempt('ECS_API', async () => {
    const service = await aws.describeService(
      requireSetting(settings, 'ECS_CLUSTER_NAME'),
      requireSetting(settings, 'ECS_API_SERVICE_NAME'),
    );
    if (service.desiredCount === 0) return false;
    await aws.updateService(service.clusterArn, service.serviceArn, 0);
    return true;
  });
  await attempt('RDS', async () => {
    const identifier = requireSetting(settings, 'RDS_INSTANCE_IDENTIFIER');
    const instance = await aws.describeDatabase(identifier);
    if (['stopped', 'stopping'].includes(instance.DBInstanceStatus)) return false;
    if (instance.DBInstanceStatus !== 'available') {
      throw new Error(`RDS is not currently stoppable (${instance.DBInstanceStatus})`);
    }
    await aws.stopDatabase(identifier);
    return true;
  });

  const outcome = changed ? 'AUTO_SLEEP_TRIGGERED' : 'NOOP_ALREADY_SLEEPING';
  emit(log, outcome, { expiresAt: deadline.expiresAt });
  return { outcome, expiresAt: deadline.expiresAt };
};

const createAwsSdkAdapter = async (region) => {
  const [sts, ssm, scheduler, ecs, rds] = await Promise.all([
    import('@aws-sdk/client-sts'),
    import('@aws-sdk/client-ssm'),
    import('@aws-sdk/client-scheduler'),
    import('@aws-sdk/client-ecs'),
    import('@aws-sdk/client-rds'),
  ]);
  const stsClient = new sts.STSClient({ region });
  const ssmClient = new ssm.SSMClient({ region });
  const schedulerClient = new scheduler.SchedulerClient({ region });
  const ecsClient = new ecs.ECSClient({ region });
  const rdsClient = new rds.RDSClient({ region });
  return {
    getCallerIdentity: () => stsClient.send(new sts.GetCallerIdentityCommand({})),
    async getParameter(name) {
      try {
        const response = await ssmClient.send(new ssm.GetParameterCommand({ Name: name }));
        return response.Parameter?.Value;
      } catch (error) {
        if (error?.name === 'ParameterNotFound') return undefined;
        throw error;
      }
    },
    getSchedule: (name) => schedulerClient.send(new scheduler.GetScheduleCommand({ Name: name })),
    updateSchedule: (input) => schedulerClient.send(new scheduler.UpdateScheduleCommand(input)),
    async describeService(cluster, service) {
      const response = await ecsClient.send(
        new ecs.DescribeServicesCommand(ecsDescribeServicesInput(cluster, service)),
      );
      if (!response.services?.[0] || response.failures?.length) {
        throw new Error('ECS API service is unavailable');
      }
      return response.services[0];
    },
    updateService: (cluster, service, desiredCount) =>
      ecsClient.send(
        new ecs.UpdateServiceCommand(ecsUpdateServiceInput(cluster, service, desiredCount)),
      ),
    async describeDatabase(identifier) {
      const response = await rdsClient.send(
        new rds.DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }),
      );
      if (!response.DBInstances?.[0]) throw new Error('RDS instance is unavailable');
      return response.DBInstances[0];
    },
    stopDatabase: (identifier) =>
      rdsClient.send(new rds.StopDBInstanceCommand({ DBInstanceIdentifier: identifier })),
  };
};

let defaultAws;
export const handler = async () => {
  defaultAws ??= await createAwsSdkAdapter(process.env.AWS_REGION);
  return runAutoSleep({ aws: defaultAws, settings: process.env });
};
