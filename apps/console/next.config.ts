import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Type errors fail the build rather than warning. CLAUDE.md rule #8.
  // Next 16 dropped its built-in ESLint integration; linting runs from the root `pnpm lint`.
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
