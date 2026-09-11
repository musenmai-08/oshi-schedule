import assert from 'node:assert/strict';
import test from 'node:test';
import { URL } from 'node:url';
import { toLibpqUrl } from './libpq-url.mjs';

test('removes Prisma parameters while retaining libpq sslmode', () => {
  const result = toLibpqUrl(
    'postgresql://user:pass@example.test:6543/db?schema=app&sslmode=require&pgbouncer=true&connection_limit=1&pool_timeout=10&connect_timeout=5',
  );
  const parsed = new URL(result);
  assert.equal(parsed.searchParams.get('sslmode'), 'require');
  assert.equal(parsed.searchParams.has('schema'), false);
  assert.equal(parsed.searchParams.has('pgbouncer'), false);
  assert.equal(parsed.searchParams.has('connection_limit'), false);
  assert.equal(parsed.searchParams.has('pool_timeout'), false);
  assert.equal(parsed.searchParams.has('connect_timeout'), false);
});
