import { createHash } from 'node:crypto';
import console from 'node:console';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const digest = (value) => createHash('sha256').update(value).digest('hex');

export const repositoryMigrationState = async (migrationsDirectory = 'prisma/migrations') => {
  const names = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      checksum: digest(await readFile(`${migrationsDirectory}/${name}/migration.sql`)),
    })),
  );
};

export const parseDatabaseMigrationState = (text) => {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.shift() !== 'migration_name,checksum')
    throw new Error('migration state CSV header is invalid');
  return lines.map((line) => {
    const separator = line.indexOf(',');
    if (separator < 1) throw new Error('migration state CSV row is invalid');
    return { name: line.slice(0, separator), checksum: line.slice(separator + 1) };
  });
};

export const assertMigrationStatesEqual = (expected, actual) => {
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    throw new Error('database migration state does not match repository migrations');
};

export const assertMigrationStatePrefix = (repository, database) => {
  assertMigrationStatesEqual(repository.slice(0, database.length), database);
};

const main = async () => {
  const [command, statePath, manifestPath, expectedCommit] = process.argv.slice(2);
  if (!['create', 'create-backup', 'verify', 'verify-restored'].includes(command ?? ''))
    throw new Error(
      'usage: migration-state.mjs <create|create-backup|verify|verify-restored> <state.csv> <manifest.json> [commit]',
    );

  const repository = await repositoryMigrationState();
  if (command === 'create' || command === 'create-backup') {
    const database = parseDatabaseMigrationState(await readFile(statePath, 'utf8'));
    if (command === 'create') assertMigrationStatesEqual(repository, database);
    else assertMigrationStatePrefix(repository, database);
    if (!expectedCommit) throw new Error('create requires an exact Git commit');
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          kind: command === 'create' ? 'release' : 'backup',
          gitCommit: expectedCommit,
          migrations: database,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    return;
  }

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.migrations))
    throw new Error('migration manifest is invalid');
  if (expectedCommit && manifest.gitCommit !== expectedCommit)
    throw new Error('migration manifest Git commit does not match the release');
  if (manifest.kind === 'release') assertMigrationStatesEqual(repository, manifest.migrations);
  else if (manifest.kind === 'backup') assertMigrationStatePrefix(repository, manifest.migrations);
  else throw new Error('migration manifest kind is invalid');
  if (command === 'verify-restored') {
    const restored = parseDatabaseMigrationState(await readFile(statePath, 'utf8'));
    assertMigrationStatesEqual(manifest.migrations, restored);
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'migration state verification failed');
    process.exitCode = 1;
  });
