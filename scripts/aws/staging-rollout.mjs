import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import {
  buildPhaseContext,
  formatContextSummary,
  loadCommonContext,
  projectRoot,
  toCdkContextArgs,
} from './staging-context.mjs';

const usage =
  'Usage: staging-rollout.sh <phase1|phase2> [synth|diff|deploy|--dry-run] [CDK options]';
const rawArguments = process.argv.slice(2);
const phase = rawArguments.shift();
if (rawArguments[0] === '--') rawArguments.shift();
const command = rawArguments.shift() ?? 'synth';

if (!['phase1', 'phase2'].includes(phase)) {
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}

const forbiddenOption = rawArguments.find(
  (argument) =>
    argument === '-c' ||
    argument.startsWith('-c=') ||
    argument.startsWith('-c') ||
    argument === '--context' ||
    argument.startsWith('--context=') ||
    argument === '--app' ||
    argument.startsWith('--app=') ||
    argument === '--profile' ||
    argument.startsWith('--profile='),
);
if (forbiddenOption) {
  process.stderr.write(
    'Staging rollout context, CDK app, and AWS profile are owned by the formal preset.\n',
  );
  process.exit(2);
}

const common = await loadCommonContext();
if (command === '--dry-run' || command === 'show') {
  process.stdout.write(`${formatContextSummary(common, phase)}\n`);
  process.exit(0);
}
if (!['synth', 'diff', 'deploy'].includes(command)) {
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}

const cdkOptions = [...rawArguments];
if (command === 'synth' && !cdkOptions.includes('--quiet') && !cdkOptions.includes('-q'))
  cdkOptions.push('--quiet');
if (command === 'diff' && !cdkOptions.includes('--no-change-set'))
  cdkOptions.push('--no-change-set');

// pnpm hoists the workspace-owned CDK CLI to the repository root.  Do not
// assume an infra-local node_modules directory exists in a clean checkout.
const cdkExecutable = path.join(projectRoot, 'node_modules/.bin/cdk');
const result = spawnSync(
  cdkExecutable,
  [command, ...cdkOptions, ...toCdkContextArgs(buildPhaseContext(common, phase))],
  {
    cwd: path.join(projectRoot, 'infra'),
    env: process.env,
    stdio: 'inherit',
  },
);

if (result.error) throw result.error;
if (result.signal) {
  process.stderr.write(`CDK terminated by ${result.signal}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
