import { NextResponse } from 'next/server';
import { handleAuthCallback } from '@/lib/auth-callback';
import { publicEnv } from '@/lib/env';
import { resolveWebOrigin } from '@/lib/server-web-origin';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function GET(request: Request) {
  let webOrigin: string;
  try {
    webOrigin = resolveWebOrigin();
  } catch {
    return NextResponse.json({ error: 'Web origin is not configured' }, { status: 500 });
  }
  const supabase = await createSupabaseServerClient();
  return handleAuthCallback(request, {
    webOrigin,
    apiUrl: publicEnv.apiUrl,
    exchangeCodeForSession: (code) => supabase.auth.exchangeCodeForSession(code),
    fetch,
  });
}
