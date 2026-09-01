import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');

test('PostgreSQL baseline keeps application objects in the private app schema', async () => {
  const [schema, migration] = await Promise.all([
    read('prisma/schema.prisma'),
    read('prisma/migrations/20260901000000_postgresql_baseline/migration.sql'),
  ]);
  assert.match(schema, /provider\s+=\s+"postgresql"/);
  assert.match(schema, /schemas\s+=\s+\["app"\]/);
  assert.match(schema, /binaryTargets\s+=\s+\["native", "rhel-openssl-3\.0\.x"\]/);
  assert.match(migration, /CREATE SCHEMA IF NOT EXISTS "app"/);
  assert.match(migration, /REVOKE ALL ON SCHEMA "app" FROM PUBLIC/);
  assert.match(migration, /CREATE TYPE "app"\./);
  assert.match(migration, /CREATE TABLE "app"\./);
  assert.match(migration, /ALTER TABLE "app"\./);
  assert.match(migration, /TIMESTAMPTZ\(3\)/);
});

test('PrismaStore uses PostgreSQL locking, upsert and interval semantics', async () => {
  const source = await read('apps/api/src/infrastructure/database/prisma-store.ts');
  assert.match(source, /"app"\."SyncLease"/);
  assert.match(source, /ON CONFLICT \("key"\) DO NOTHING/);
  assert.match(source, /INTERVAL '1 millisecond'/);
  assert.match(source, /TransactionIsolationLevel\.Serializable/);
  assert.doesNotMatch(source, /INSERT IGNORE|UTC_TIMESTAMP|TIMESTAMPADD/);
});

test('MySQL migration history remains available only as an archive', async () => {
  const [lock, archive] = await Promise.all([
    read('prisma/migrations/migration_lock.toml'),
    read('prisma/migrations-mysql/20260720000000_init/migration.sql'),
  ]);
  assert.match(lock, /provider = "postgresql"/);
  assert.match(archive, /CREATE TABLE/);
});
