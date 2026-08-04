import type { NextConfig } from 'next';
import { buildSecurityHeaders } from './src/lib/security-headers';

const config: NextConfig = {
  transpilePackages: ['@oshi-schedule/shared'],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: buildSecurityHeaders({
          production: process.env.NODE_ENV === 'production',
          apiUrl: process.env.NEXT_PUBLIC_API_URL,
          supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
        }),
      },
    ];
  },
};
export default config;
