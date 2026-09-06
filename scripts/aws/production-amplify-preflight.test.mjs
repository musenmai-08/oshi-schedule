import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAmplifyReadPlan,
  PRODUCTION_REPOSITORY_URL,
  validateAmplifyState,
} from './production-amplify-preflight.mjs';

test('repository connection preflight uses only App-scoped Amplify read APIs', () => {
  assert.deepEqual(buildAmplifyReadPlan('before-repository-connect', 'd1example'), [
    ['amplify', 'get-app', '--app-id', 'd1example'],
    ['amplify', 'list-branches', '--app-id', 'd1example'],
    ['amplify', 'list-domain-associations', '--app-id', 'd1example'],
  ]);
  assert.throws(
    () => buildAmplifyReadPlan('before-repository-connect', ''),
    /AMPLIFY_APP_ID is required/,
  );
  assert.deepEqual(buildAmplifyReadPlan('before-detached', ''), [['amplify', 'list-apps']]);
});

test('detached phase permits only an absent or disconnected empty App', () => {
  assert.doesNotThrow(() =>
    validateAmplifyState('before-detached', {
      exists: false,
      repository: '',
      branchCount: 0,
      domainCount: 0,
    }),
  );
  assert.doesNotThrow(() =>
    validateAmplifyState('before-repository-connect', {
      exists: true,
      repository: '',
      branchCount: 0,
      domainCount: 0,
    }),
  );
  assert.throws(() =>
    validateAmplifyState('before-repository-connect', {
      exists: true,
      repository: '',
      branchCount: 1,
      domainCount: 0,
    }),
  );
});

test('connected phase requires exact repository URL before Branch and Domain creation', () => {
  assert.doesNotThrow(() =>
    validateAmplifyState('before-connected', {
      exists: true,
      repository: PRODUCTION_REPOSITORY_URL,
      branchCount: 0,
      domainCount: 0,
    }),
  );
  assert.throws(() =>
    validateAmplifyState('before-connected', {
      exists: true,
      repository: 'https://github.com/attacker/repository',
      branchCount: 0,
      domainCount: 0,
    }),
  );
});
