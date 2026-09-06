import { spawnSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const PRODUCTION_AMPLIFY_APP_NAME = 'oshi-schedule-production-web';
export const PRODUCTION_REPOSITORY_URL = 'https://github.com/musenmai-08/oshi-schedule';

export const validateAmplifyState = (mode, state) => {
  if (!['before-detached', 'before-repository-connect', 'before-connected'].includes(mode))
    throw new Error('unknown production Amplify preflight mode');
  if (mode === 'before-detached' && !state.exists) return;
  if (!state.exists) throw new Error('production Amplify App does not exist');
  if (state.branchCount !== 0 || state.domainCount !== 0) {
    if (
      mode === 'before-connected' &&
      state.repository === PRODUCTION_REPOSITORY_URL &&
      state.branchCount === 1 &&
      state.domainCount === 1 &&
      state.branchNames?.[0] === 'main' &&
      state.domainNames?.[0] === 'oshi-schedule.com'
    )
      return;
    throw new Error('production Amplify phase requires zero Branch and Domain resources');
  }
  if (mode === 'before-connected') {
    if (state.repository !== PRODUCTION_REPOSITORY_URL)
      throw new Error('production Amplify repository is not connected to the approved repository');
  } else if (state.repository) {
    throw new Error('production Amplify repository must be disconnected for this phase');
  }
};

const awsJson = (args) => {
  const result = spawnSync('aws', [...args, '--output', 'json'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'AWS read failed');
  return JSON.parse(result.stdout);
};

const currentState = () => {
  const apps = awsJson(['amplify', 'list-apps']).apps ?? [];
  const matches = apps.filter((app) => app.name === PRODUCTION_AMPLIFY_APP_NAME);
  if (matches.length > 1) throw new Error('multiple production Amplify Apps found');
  if (!matches.length) return { exists: false, repository: '', branchCount: 0, domainCount: 0 };
  const app = matches[0];
  const branches = awsJson(['amplify', 'list-branches', '--app-id', app.appId]).branches ?? [];
  const domains =
    awsJson(['amplify', 'list-domain-associations', '--app-id', app.appId]).domainAssociations ??
    [];
  return {
    exists: true,
    appId: app.appId,
    repository: app.repository ?? '',
    branchCount: branches.length,
    domainCount: domains.length,
    branchNames: branches.map((branch) => branch.branchName).sort(),
    domainNames: domains.map((domain) => domain.domainName).sort(),
  };
};

const main = () => {
  const mode = process.argv[2];
  validateAmplifyState(mode, currentState());
  console.log(`production Amplify preflight PASS: ${mode}`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'production Amplify preflight failed');
    process.exitCode = 1;
  }
}
