/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The shared package is a workspace TS source — let Next transpile it.
  transpilePackages: ['@orch-agents/shared'],
  experimental: {
    // Stream SSE via the Node runtime so backpressure works correctly.
  },
};

module.exports = nextConfig;
