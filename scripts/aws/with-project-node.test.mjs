import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const wrapper = path.join(scriptDirectory, 'with-project-node.sh');
const expectedVersion = '22.23.1';

const createExecutable = async (file, source) => {
  await writeFile(file, source, 'utf8');
  await chmod(file, 0o755);
};

describe('AWS project Node wrapper', () => {
  it('selects the .nvmrc Node even when an incompatible node is first in PATH', async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'oshi-node-path-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    const poisonDirectory = path.join(root, 'poison');
    const nvmBin = path.join(root, 'nvm', 'versions', 'node', `v${expectedVersion}`, 'bin');
    await mkdir(poisonDirectory, { recursive: true });
    await mkdir(nvmBin, { recursive: true });
    await createExecutable(path.join(poisonDirectory, 'node'), "#!/bin/sh\nprintf '99.0.0\\n'\n");
    await symlink(process.execPath, path.join(nvmBin, 'node'));

    const result = spawnSync('bash', [wrapper, 'node', '-p', 'process.versions.node'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NVM_DIR: path.join(root, 'nvm'),
        PATH: `${poisonDirectory}:${process.env.PATH}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expectedVersion);
  });

  it('rejects execution when Node 22.23.1 cannot be selected', async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'oshi-node-missing-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    const poisonDirectory = path.join(root, 'poison');
    await mkdir(poisonDirectory, { recursive: true });
    await createExecutable(path.join(poisonDirectory, 'node'), "#!/bin/sh\nprintf '99.0.0\\n'\n");

    const result = spawnSync('/bin/bash', [wrapper, 'node', '--version'], {
      encoding: 'utf8',
      env: {
        HOME: root,
        NVM_DIR: path.join(root, 'nvm'),
        PATH: `${poisonDirectory}:/usr/bin:/bin`,
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Node\.js 22\.23\.1 is required/);
  });
});
