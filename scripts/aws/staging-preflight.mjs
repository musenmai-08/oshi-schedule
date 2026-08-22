#!/usr/bin/env node

import { execFile } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadRepositoryContext, projectRoot } from './staging-context.mjs';
import { STAGING, collectStatus, createAwsCli, validateTarget } from './staging-operations.mjs';

const execFileAsync = promisify(execFile);

const amplifyRuntime = Object.freeze({
  applicationActivation: 'READY',
  api: Object.freeze({ desiredCount: 1, runningCount: 1, pendingCount: 0 }),
  rds: 'available',
  pipe: 'RUNNING',
});

const amplifyProfile = (configuredPhase, repositoryState, branchPresent, domainPresent) =>
  Object.freeze({
    ...amplifyRuntime,
    configuredPhase,
    amplify: Object.freeze({ repositoryState, branchPresent, domainPresent }),
  });

const profiles = Object.freeze({
  'amplify-manual': amplifyProfile('manual', 'DISCONNECTED', true, true),
  'amplify-to-domain-detached': amplifyProfile('domain-detached', 'DISCONNECTED', true, true),
  'amplify-domain-detached': amplifyProfile('domain-detached', 'DISCONNECTED', true, false),
  'amplify-to-detached': amplifyProfile('detached', 'DISCONNECTED', true, false),
  'amplify-detached': amplifyProfile('detached', 'DISCONNECTED', false, false),
  'amplify-repository-connected': amplifyProfile('detached', 'CONNECTED', false, false),
  'amplify-to-connected': amplifyProfile('connected', 'CONNECTED', false, false),
  'amplify-connected': amplifyProfile('connected', 'CONNECTED', true, true),
  phase2: Object.freeze({
    applicationActivation: 'NOT_READY',
    api: Object.freeze({ desiredCount: 0, runningCount: 0, pendingCount: 0 }),
    rds: 'available',
    pipe: 'STOPPED',
  }),
});

const amplifyArguments = Object.freeze([
  'manual',
  'to-domain-detached',
  'domain-detached',
  'to-detached',
  'detached',
  'repository-connected',
  'to-connected',
  'connected',
]);

export const resolvePreflightPurpose = (purpose, configuredAmplifyPhase) => {
  if (purpose !== 'amplify-configured') return purpose;
  return `amplify-${configuredAmplifyPhase}`;
};

const terminalStackStatuses = new Set([
  'CREATE_COMPLETE',
  'IMPORT_COMPLETE',
  'IMPORT_ROLLBACK_COMPLETE',
  'ROLLBACK_COMPLETE',
  'UPDATE_COMPLETE',
  'UPDATE_ROLLBACK_COMPLETE',
]);

export const parsePreflightArguments = (args = []) => {
  if (args.length === 0 || (args.length === 1 && args[0] === '--amplify'))
    return 'amplify-configured';
  if (args.length === 1 && args[0] === '--phase2') return 'phase2';
  if (args.length === 1 && amplifyArguments.some((phase) => args[0] === `--amplify-${phase}`))
    return args[0].slice(2);
  throw new Error(
    'Usage: staging:preflight [--amplify|--amplify-manual|--amplify-to-domain-detached|' +
      '--amplify-domain-detached|--amplify-to-detached|--amplify-detached|' +
      '--amplify-repository-connected|--amplify-to-connected|--amplify-connected|--phase2]',
  );
};

const check = (name, actual, expected, ok = actual === expected) => ({
  name,
  ok,
  actual: String(actual),
  expected: String(expected),
});

export const evaluatePreflight = ({
  purpose,
  identity,
  region,
  gitClean,
  status,
  configuredAmplifyPhase,
}) => {
  const expected = profiles[purpose];
  if (!expected) throw new Error(`Unknown preflight purpose: ${purpose}`);

  const queue = status.syncJobs ?? {};
  const api = status.api ?? {};
  const activation = status.applicationActivation?.state;
  const deadline = status.autoSleep?.state;
  const pipeState = queue.state;
  const pipeDesiredState = queue.desiredState;
  const queueState = `${queue.queuedMessages ?? 'unknown'}/${queue.inFlightMessages ?? 'unknown'}/${queue.delayedMessages ?? 'unknown'}`;
  const expectedApi = `${expected.api.desiredCount}/${expected.api.runningCount}/${expected.api.pendingCount}`;
  const actualApi = `${api.desiredCount ?? 'unknown'}/${api.runningCount ?? 'unknown'}/${api.pendingCount ?? 'unknown'}`;

  const checks = [
    check(
      'AWS account / region',
      `${identity.Account ?? 'unknown'} / ${region || 'unset'}`,
      `${STAGING.accountId} / ${STAGING.region}`,
    ),
    check('Git working tree', gitClean ? 'clean' : 'dirty', 'clean'),
    check(
      'CloudFormation terminal',
      status.stack?.state ?? 'unknown',
      'terminal',
      terminalStackStatuses.has(status.stack?.state),
    ),
    check('Application activation', activation ?? 'unknown', expected.applicationActivation),
    check('API desired/running/pending', actualApi, expectedApi),
    check('RDS', status.rds?.state ?? 'unknown', expected.rds),
    check('Pipe desired state', pipeDesiredState ?? 'unknown', expected.pipe),
    check('Pipe current state', pipeState ?? 'unknown', expected.pipe),
    check('Worker Scheduler', status.scheduler?.state ?? 'unknown', 'DISABLED'),
    check('Queue visible/in-flight/delayed', queueState, '0/0/0'),
    check('Wake deadline', deadline ?? 'unknown', 'ACTIVE'),
  ];
  if (expected.amplify) {
    const amplify = status.amplify ?? {};
    const branchActual = `${amplify.branchCount ?? 'unknown'}/${amplify.mainBranch?.state ?? 'unknown'}/${
      amplify.mainBranch?.enableAutoBuild ?? 'n/a'
    }`;
    const branchExpected = expected.amplify.branchPresent
      ? '1/DEPLOYED/false'
      : '0/NOT_DEPLOYED/n/a';
    const domainActual = `${amplify.domainCount ?? 'unknown'}/${amplify.domain?.state ?? 'unknown'}/${
      amplify.domain?.stagingSubdomainVerified ?? false
    }`;
    const domainExpected = expected.amplify.domainPresent
      ? '1/AVAILABLE/true'
      : '0/NOT_DEPLOYED/false';
    checks.push(
      check(
        'Configured Amplify phase',
        configuredAmplifyPhase ?? 'unknown',
        expected.configuredPhase,
      ),
      check('Amplify App', amplify.state ?? 'unknown', 'DEPLOYED'),
      check(
        'Amplify repository',
        amplify.repositoryState ?? 'unknown',
        expected.amplify.repositoryState,
      ),
      check('Amplify branches/main/auto-build', branchActual, branchExpected),
      check('Amplify domains/status/verified', domainActual, domainExpected),
    );
  }
  return checks;
};

export const inspectGitClean = async ({ exec = execFileAsync } = {}) => {
  const { stdout } = await exec('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim() === '';
};

export const runPreflight = async (
  purpose,
  {
    aws = createAwsCli(),
    inspectGit = inspectGitClean,
    loadRepository = loadRepositoryContext,
  } = {},
) => {
  validateTarget(STAGING);
  const [identity, region, gitClean, status, repositoryContext] = await Promise.all([
    aws.json(['sts', 'get-caller-identity']),
    aws.text(['configure', 'get', 'region'], { region: false }),
    inspectGit(),
    collectStatus(aws),
    loadRepository(),
  ]);
  const resolvedPurpose = resolvePreflightPurpose(
    purpose,
    repositoryContext.amplifyConnectionPhase,
  );
  const checks = evaluatePreflight({
    purpose: resolvedPurpose,
    identity,
    region,
    gitClean,
    status,
    configuredAmplifyPhase: repositoryContext.amplifyConnectionPhase,
  });
  return { purpose: resolvedPurpose, checks, ok: checks.every(({ ok }) => ok) };
};

export const formatPreflight = ({ purpose, checks, ok }) => {
  const lines = [`Staging preflight: ${purpose}`];
  for (const result of checks) {
    lines.push(
      `${result.ok ? 'PASS' : 'FAIL'} ${result.name}: ${result.actual}` +
        (result.ok ? '' : ` (expected ${result.expected})`),
    );
  }
  lines.push(ok ? 'Preflight passed' : 'Preflight failed');
  return lines.join('\n');
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const purpose = parsePreflightArguments(process.argv.slice(2));
    const result = await runPreflight(purpose);
    console.log(formatPreflight(result));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`Preflight failed: ${error.message}`);
    process.exitCode = 1;
  }
}
