import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

const run = (fixture) =>
  spawnSync(process.execPath, ['scripts/validate-ecr-basic-scan.mjs', '--findings', fixture], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

test('accepts a complete ECR scan with only production-approved findings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ecr-basic-scan-'));
  try {
    const fixture = join(directory, 'approved.json');
    await writeFile(
      fixture,
      JSON.stringify({
        imageScanStatus: { status: 'COMPLETE' },
        imageScanFindings: {
          findings: [{ name: 'CVE-2026-13221', severity: 'HIGH', attributes: [] }],
        },
      }),
    );
    const result = run(fixture);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects an unapproved critical finding without exposing its description', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ecr-basic-scan-'));
  try {
    const fixture = join(directory, 'rejected.json');
    await writeFile(
      fixture,
      JSON.stringify({
        imageScanStatus: { status: 'COMPLETE' },
        imageScanFindings: {
          findings: [
            {
              name: 'CVE-2099-99999',
              severity: 'CRITICAL',
              description: 'must not be printed',
              attributes: [
                { key: 'package_name', value: 'example-package' },
                { key: 'package_version', value: '1.2.3' },
              ],
            },
          ],
        },
      }),
    );
    const result = run(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CVE-2099-99999/);
    assert.doesNotMatch(result.stderr, /must not be printed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
