import { existsSync } from 'node:fs';
import type { NextConfig } from 'next';

// All env vars live in the repo-root `.env`.
const rootEnv = new URL('../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  transpilePackages: ['@curio/shared'],
};

export default nextConfig;
