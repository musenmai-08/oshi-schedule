import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const validator = path.join(repositoryRoot, 'scripts/validate-trivy-ignore.mjs');

test('allows an empty policy while retaining expiry enforcement for future exceptions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'oshi-trivy-policy-'));
  try {
    const empty = path.join(directory, 'empty');
    const expired = path.join(directory, 'expired');
    await writeFile(empty, '# no active exceptions\n');
    await writeFile(expired, 'CVE-2026-99999 exp:2026-09-11\n');

    const emptyResult = spawnSync(process.execPath, [validator, empty, '--date', '2026-09-11'], {
      encoding: 'utf8',
    });
    assert.equal(emptyResult.status, 0, emptyResult.stderr);
    assert.match(emptyResult.stdout, /no active CVE exceptions/);

    const expiredResult = spawnSync(
      process.execPath,
      [validator, expired, '--date', '2026-09-11'],
      { encoding: 'utf8' },
    );
    assert.equal(expiredResult.status, 1);
    assert.match(expiredResult.stderr, /expired on 2026-09-11/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
