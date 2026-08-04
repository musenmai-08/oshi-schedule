import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { requireSupabasePublicEnv } from '../env';

export async function createSupabaseServerClient() {
  const store = await cookies();
  const env = requireSupabasePublicEnv();
  return createServerClient(env.supabaseUrl, env.supabasePublishableKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (values) => {
        try {
          values.forEach(({ name, value, options }) => store.set(name, value, options));
        } catch {
          /* Server components cannot always set cookies. */
        }
      },
    },
  });
}
