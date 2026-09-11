import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { URL } from 'node:url';

const workflow = (name) =>
  readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');

test('production migration and infrastructure deploy are separate approval boundaries', async () => {
  const deploy = await workflow('deploy-production.yml');
  const migration = await workflow('migrate-production.yml');
  assert.match(deploy, /environment: production-infra/);
  assert.match(deploy, /migration_run_id/);
  assert.match(deploy, /production-migration-attestation/);
  assert.doesNotMatch(deploy, /prisma migrate deploy|GetSecretValue/);
  assert.match(migration, /environment: production-migration/);
  assert.match(migration, /prisma migrate deploy/);
  assert.match(migration, /migration-state\.mjs create/);
  assert.match(migration, /libpq-url\.mjs/);
  assert.match(migration, /add-mask::\$PSQL_DATABASE_URL/);
  assert.match(migration, /DATABASE_URL="\$PSQL_DATABASE_URL"/);
});

test('production Amplify connection is guarded before connected resources are deployed', async () => {
  const deploy = await workflow('deploy-production.yml');
  const connect = await workflow('connect-production-amplify.yml');
  assert.match(deploy, /options: \[detached, connected\]/);
  assert.match(deploy, /production-amplify-preflight\.mjs/);
  assert.match(deploy, /AMPLIFY_APP_ID: \$\{\{ vars\.PRODUCTION_AMPLIFY_APP_ID \}\}/);
  assert.match(connect, /environment: production-amplify/);
  assert.match(connect, /AMPLIFY_APP_ID: \$\{\{ vars\.PRODUCTION_AMPLIFY_APP_ID \}\}/);
  assert.match(connect, /before-repository-connect/);
  assert.match(connect, /before-connected/);
  assert.match(connect, /trap 'rm -f "\$request"; unset AMPLIFY_GITHUB_PAT'/);
});

test('production backups pair every dump with an exact migration manifest', async () => {
  const backup = await workflow('backup-production.yml');
  assert.match(backup, /environment: production-backup/);
  assert.match(backup, /app\._prisma_migrations/);
  assert.match(backup, /migration-state\.mjs create-backup/);
  assert.match(backup, /\.migrations\.json/);
  assert.match(backup, /libpq-url\.mjs/);
  assert.match(backup, /add-mask::\$PSQL_DATABASE_URL/);
  assert.match(backup, /DATABASE_URL="\$PSQL_DATABASE_URL"/);
  assert.doesNotMatch(backup, /s3 rm|DeleteObject/);
});
