import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertMigrationStatesEqual,
  assertMigrationStatePrefix,
  parseDatabaseMigrationState,
  repositoryMigrationState,
} from './migration-state.mjs';

test('binds ordered migration IDs to the exact migration.sql checksums', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oshi-migrations-'));
  await mkdir(join(root, '002_second'));
  await mkdir(join(root, '001_first'));
  await writeFile(join(root, '001_first/migration.sql'), 'select 1;\n');
  await writeFile(join(root, '002_second/migration.sql'), 'select 2;\n');
  const state = await repositoryMigrationState(root);
  assert.deepEqual(
    state.map(({ name }) => name),
    ['001_first', '002_second'],
  );
  assert.match(state[0].checksum, /^[a-f0-9]{64}$/);
  assert.notEqual(state[0].checksum, state[1].checksum);
});

test('rejects missing, reordered, or changed database migrations', () => {
  const state = parseDatabaseMigrationState('migration_name,checksum\n001_first,abc\n');
  assert.deepEqual(state, [{ name: '001_first', checksum: 'abc' }]);
  assert.throws(() => assertMigrationStatesEqual(state, []), /does not match/);
  assert.throws(
    () => assertMigrationStatesEqual(state, [{ name: '001_first', checksum: 'changed' }]),
    /does not match/,
  );
  assert.doesNotThrow(() =>
    assertMigrationStatePrefix([state[0], { name: '002_second', checksum: 'def' }], state),
  );
  assert.throws(
    () => assertMigrationStatePrefix([{ name: '001_first', checksum: 'changed' }], state),
    /does not match/,
  );
});
