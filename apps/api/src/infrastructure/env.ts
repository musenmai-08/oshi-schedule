import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const ROOT_ENV_PATH = fileURLToPath(new URL('../../../../.env', import.meta.url));
loadDotenv({ path: ROOT_ENV_PATH, quiet: true });

export const DEVELOPMENT_TOKEN_ENCRYPTION_KEYS = 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_MODE: z.enum(['fake', 'real']).default('fake'),
  PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().optional(),
  ALLOWED_EMAILS: z.string().default('developer@example.com'),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_JWT_AUDIENCE: z.string().default('authenticated'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  YOUTUBE_API_KEY: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  TOKEN_ENCRYPTION_KEYS: z.string().default(DEVELOPMENT_TOKEN_ENCRYPTION_KEYS),
});
export type Env = z.infer<typeof schema>;
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const env = schema.parse(source);
  if (env.NODE_ENV === 'production' || env.APP_MODE === 'real') {
    for (const key of [
      'DATABASE_URL',
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'YOUTUBE_API_KEY',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
    ] as const) {
      if (!env[key]) throw new Error(`Missing required environment variable: ${key}`);
    }
    if (env.APP_MODE === 'fake') throw new Error('Fake mode is forbidden in production');
    if (env.TOKEN_ENCRYPTION_KEYS === DEVELOPMENT_TOKEN_ENCRYPTION_KEYS)
      throw new Error('TOKEN_ENCRYPTION_KEYS must not use the development default');
  }
  return env;
}
