import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, ROOT_ENV_PATH } from './env.js';

const realEnv = {
  NODE_ENV: 'production',
  APP_MODE: 'real',
  DATABASE_URL: 'mysql://user:password@localhost:3306/test',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  YOUTUBE_API_KEY: 'youtube-key',
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
};

describe('loadEnv production encryption keys', () => {
  it('rejects the documented all-zero development key', () => {
    expect(() => loadEnv(realEnv)).toThrow(/TOKEN_ENCRYPTION_KEYS/);
  });

  it('accepts a non-default 32-byte key', () => {
    const key = randomBytes(32).toString('base64');
    expect(
      loadEnv({
        ...realEnv,
        TOKEN_ENCRYPTION_KEYS: `v2:${key}`,
      }).APP_MODE,
    ).toBe('real');
  });

  it.each([
    ['short-period', Buffer.from(Array.from({ length: 32 }, (_, index) => index % 8))],
    ['sequential', Buffer.from(Array.from({ length: 32 }, (_, index) => index))],
  ])('rejects a predictable %s key', (_name, bytes) => {
    expect(() =>
      loadEnv({
        ...realEnv,
        TOKEN_ENCRYPTION_KEYS: `v2:${bytes.toString('base64')}`,
      }),
    ).toThrow(/predictable|unsafe|low-entropy/);
  });

  it('rejects malformed base64 instead of accepting a lenient decode', () => {
    expect(() => loadEnv({ ...realEnv, TOKEN_ENCRYPTION_KEYS: `v2:${'!'.repeat(44)}` })).toThrow(
      /base64/i,
    );
  });

  it('rejects all-zero and low-entropy keys even when the key identifier changes', () => {
    expect(() =>
      loadEnv({
        ...realEnv,
        TOKEN_ENCRYPTION_KEYS: `v2:${Buffer.alloc(32).toString('base64')}`,
      }),
    ).toThrow(/low-entropy/);
    expect(() =>
      loadEnv({
        ...realEnv,
        TOKEN_ENCRYPTION_KEYS: `production:${Buffer.alloc(32, 9).toString('base64')}`,
      }),
    ).toThrow(/low-entropy/);
  });

  it('requires deletion lease duration to exceed every deletion HTTP timeout', () => {
    expect(() =>
      loadEnv({
        ...realEnv,
        TOKEN_ENCRYPTION_KEYS: `v1:${randomBytes(32).toString('base64')}`,
        EXTERNAL_API_TIMEOUT_MS: '10000',
        ACCOUNT_DELETION_LEASE_MS: '10000',
      }),
    ).toThrow(/ACCOUNT_DELETION_LEASE_MS/);
  });

  it('rejects production quota settings whose reserve cannot cover bounded retries', () => {
    expect(() =>
      loadEnv({
        ...realEnv,
        TOKEN_ENCRYPTION_KEYS: `v2:${randomBytes(32).toString('base64')}`,
        YOUTUBE_MAX_TRACKED_BROADCASTS_PER_CHANNEL: '51',
        YOUTUBE_SCHEDULED_QUOTA_RESERVE: '432',
      }),
    ).toThrow(/reserve must be at least 648/);
  });

  it('allows the documented development key only outside production/real mode', () => {
    expect(loadEnv({ NODE_ENV: 'test', APP_MODE: 'fake' }).TOKEN_ENCRYPTION_KEYS).toBe(
      'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    );
  });

  it('accepts bounded proxy hops and shutdown timeout settings', () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      APP_MODE: 'fake',
      TRUST_PROXY_HOPS: '1',
      SHUTDOWN_TIMEOUT_SECONDS: '45',
    });
    expect(env.TRUST_PROXY_HOPS).toBe(1);
    expect(env.SHUTDOWN_TIMEOUT_SECONDS).toBe(45);
  });

  it.each(['-1', '1.5', '11', 'true'])('rejects invalid proxy hops %s', (value) => {
    expect(() =>
      loadEnv({ NODE_ENV: 'test', APP_MODE: 'fake', TRUST_PROXY_HOPS: value }),
    ).toThrow();
  });

  it('loads dotenv from the repository root independently of the working directory', () => {
    expect(ROOT_ENV_PATH).toBe(
      resolve(fileURLToPath(new URL('../../../../', import.meta.url)), '.env'),
    );
  });

  it('keeps Prisma generation in clean install and build/typecheck lifecycles', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../../../../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts).toMatchObject({
      postinstall: 'prisma generate',
      prebuild: 'prisma generate',
      pretypecheck: 'prisma generate',
    });
  });

  it('aligns the repository runtime and Node type declarations with Node 22', async () => {
    const root = new URL('../../../../', import.meta.url);
    const [rootPackage, webPackage, apiPackage, workerPackage, nvmrc] = await Promise.all([
      readFile(new URL('package.json', root), 'utf8'),
      readFile(new URL('apps/web/package.json', root), 'utf8'),
      readFile(new URL('apps/api/package.json', root), 'utf8'),
      readFile(new URL('apps/worker/package.json', root), 'utf8'),
      readFile(new URL('.nvmrc', root), 'utf8'),
    ]);
    expect((JSON.parse(rootPackage) as { engines: { node: string } }).engines.node).toBe(
      '>=22.23.1 <23',
    );
    for (const appPackage of [webPackage, apiPackage, workerPackage])
      expect(
        (JSON.parse(appPackage) as { devDependencies: { '@types/node': string } }).devDependencies[
          '@types/node'
        ],
      ).toMatch(/^22\./);
    expect(nvmrc.trim()).toBe('22.23.1');
  });

  it('does not advertise application settings that are fixed policies or scheduler concerns', async () => {
    const example = await readFile(new URL('../../../../.env.example', import.meta.url), 'utf8');
    expect(example).not.toMatch(
      /^(SYNC_INTERVAL_MINUTES|YOUTUBE_MIN_FETCH_INTERVAL_SECONDS|SYNC_LOOKAHEAD_DAYS)=/m,
    );
  });
});
