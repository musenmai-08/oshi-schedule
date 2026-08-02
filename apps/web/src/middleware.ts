import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { APP_ROUTES, DEMO_AUTH_COOKIE } from '@/lib/routes';

const redirectWithoutCache = (path: string, request: NextRequest) => {
  const response = NextResponse.redirect(new URL(path, request.url));
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
};

export async function middleware(request: NextRequest) {
  const protectedRoute =
    request.nextUrl.pathname === APP_ROUTES.dashboard ||
    request.nextUrl.pathname.startsWith(`${APP_ROUTES.dashboard}/`) ||
    request.nextUrl.pathname === APP_ROUTES.settings ||
    request.nextUrl.pathname.startsWith(`${APP_ROUTES.settings}/`);
  if (process.env.NEXT_PUBLIC_DEMO_MODE === 'true') {
    const authenticated = request.cookies.get(DEMO_AUTH_COOKIE)?.value === '1';
    if (request.nextUrl.pathname === APP_ROUTES.root && authenticated)
      return redirectWithoutCache(APP_ROUTES.dashboard, request);
    if (protectedRoute && !authenticated)
      return redirectWithoutCache(APP_ROUTES.root, request);
    return NextResponse.next();
  }
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookies) => {
          cookies.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookies.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );
  const { data } = await supabase.auth.getUser();
  if (request.nextUrl.pathname === APP_ROUTES.root && data.user)
    return redirectWithoutCache(APP_ROUTES.dashboard, request);
  if (protectedRoute && !data.user)
    return redirectWithoutCache(APP_ROUTES.root, request);
  if (protectedRoute) response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
export const config = { matcher: ['/', '/dashboard/:path*', '/settings/:path*'] };
