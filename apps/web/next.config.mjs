/** @type {import('next').NextConfig} */
const API_URL = process.env.API_URL ?? 'http://localhost:4000';
export default {
  reactStrictMode: true,
  poweredByHeader: false,
  // Same-origin proxy: the browser only ever talks to the web origin, so the HttpOnly session cookie is first-party.
  async rewrites() { return [{ source: '/api/:path*', destination: `${API_URL}/api/:path*` }]; },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Frame-Options', value: 'DENY' }, { key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    ] }];
  },
};
