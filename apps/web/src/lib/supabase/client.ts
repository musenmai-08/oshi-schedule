'use client';
import { createBrowserClient } from '@supabase/ssr';
import { requireSupabasePublicEnv } from '../env';

export const createSupabaseBrowserClient = () => {
  const env = requireSupabasePublicEnv();
  return createBrowserClient(env.supabaseUrl, env.supabasePublishableKey);
};
