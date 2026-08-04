type SecurityHeaderOptions = {
  production: boolean;
  apiUrl?: string;
  supabaseUrl?: string;
};

const origin = (value: string | undefined) => {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

export function buildSecurityHeaders(options: SecurityHeaderOptions) {
  const headers = [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    {
      key: 'Permissions-Policy',
      value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
    },
    { key: 'X-Frame-Options', value: 'DENY' },
  ];
  if (!options.production) return headers;

  const connectSources = [
    "'self'",
    ...new Set([origin(options.apiUrl), origin(options.supabaseUrl)].filter(Boolean)),
  ];
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    `connect-src ${connectSources.join(' ')}`,
    "worker-src 'self' blob:",
  ];
  headers.push({ key: 'Content-Security-Policy', value: directives.join('; ') });
  return headers;
}
