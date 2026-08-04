import { z } from 'zod';

const publicEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    NEXT_PUBLIC_API_URL: z.string().url().optional(),
    NEXT_PUBLIC_DEMO_MODE: z.enum(['true', 'false']).optional(),
    NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  })
  .superRefine((env, context) => {
    if (env.NODE_ENV !== 'production') return;
    for (const key of [
      'NEXT_PUBLIC_API_URL',
      'NEXT_PUBLIC_DEMO_MODE',
      'NEXT_PUBLIC_SUPABASE_URL',
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    ] as const)
      if (!env[key])
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required in production`,
        });
    if (env.NEXT_PUBLIC_DEMO_MODE === 'true')
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NEXT_PUBLIC_DEMO_MODE'],
        message: 'NEXT_PUBLIC_DEMO_MODE must be false in production',
      });
    if (env.NEXT_PUBLIC_SUPABASE_URL?.includes('your-project'))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NEXT_PUBLIC_SUPABASE_URL'],
        message: 'NEXT_PUBLIC_SUPABASE_URL must not be a placeholder',
      });
    if (env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.includes('replace_me'))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'],
        message: 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must not be a placeholder',
      });
  });

export function loadPublicEnv(source: Record<string, string | undefined>) {
  const env = publicEnvSchema.parse(source);
  return {
    apiUrl: env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
    demoMode: env.NEXT_PUBLIC_DEMO_MODE === 'true',
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
    supabasePublishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  };
}

export const publicEnv = loadPublicEnv({
  NODE_ENV: process.env.NODE_ENV,
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_DEMO_MODE: process.env.NEXT_PUBLIC_DEMO_MODE,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
});

export function requireSupabasePublicEnv() {
  if (!publicEnv.supabaseUrl || !publicEnv.supabasePublishableKey)
    throw new Error('Supabase public environment variables are required outside demo mode');
  return {
    supabaseUrl: publicEnv.supabaseUrl,
    supabasePublishableKey: publicEnv.supabasePublishableKey,
  };
}
