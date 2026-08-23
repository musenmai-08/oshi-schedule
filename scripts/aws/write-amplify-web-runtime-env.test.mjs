import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  amplifyWebRuntimeEnvPath,
  writeAmplifyWebRuntimeEnv,
} from './write-amplify-web-runtime-env.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const createWorkspace = async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'oshi-amplify-env-'));
  temporaryDirectories.push(workspaceRoot);
  await mkdir(path.join(workspaceRoot, 'apps/web'), { recursive: true });
  return workspaceRoot;
};

describe('Amplify web runtime environment generation', () => {
  it('writes only the normalized non-secret WEB_ORIGIN for Next.js SSR', async () => {
    const workspaceRoot = await createWorkspace();
    const destination = await writeAmplifyWebRuntimeEnv({
      workspaceRoot,
      environment: {
        WEB_ORIGIN: 'https://staging.oshi-schedule.com/',
        GOOGLE_CLIENT_SECRET: 'must-not-be-copied',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'must-not-be-copied',
      },
    });

    assert.equal(destination, path.join(workspaceRoot, amplifyWebRuntimeEnvPath));
    assert.equal(
      await readFile(destination, 'utf8'),
      'WEB_ORIGIN="https://staging.oshi-schedule.com"\n',
    );
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
  });

  it('refuses to overwrite an existing production env file', async () => {
    const workspaceRoot = await createWorkspace();
    const destination = path.join(workspaceRoot, amplifyWebRuntimeEnvPath);
    await writeFile(destination, 'EXISTING=value\n');

    await assert.rejects(
      writeAmplifyWebRuntimeEnv({
        workspaceRoot,
        environment: { WEB_ORIGIN: 'https://staging.oshi-schedule.com' },
      }),
      (error) => error?.code === 'EEXIST',
    );
    assert.equal(await readFile(destination, 'utf8'), 'EXISTING=value\n');
  });

  for (const value of [
    undefined,
    'not-a-url',
    'http://staging.oshi-schedule.com',
    'https://user@example.com',
    'https://staging.oshi-schedule.com/path',
  ]) {
    it(`rejects an unsafe WEB_ORIGIN: ${value ?? 'missing'}`, async () => {
      const workspaceRoot = await createWorkspace();

      await assert.rejects(
        writeAmplifyWebRuntimeEnv({ workspaceRoot, environment: { WEB_ORIGIN: value } }),
        /WEB_ORIGIN/,
      );
    });
  }
});
