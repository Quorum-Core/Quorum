import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: process.cwd(),
  },
  // 타입/ESLint를 빌드에서 강제 — 이전 ignoreBuildErrors가 타입안전성 무력화했고 CI는 빌링 블록이라
  // build가 유일 게이트. (eslint 키는 이 NextConfig 타입에 없어 제거)
  // Exclude native modules from serverless bundling (Vercel)
  serverExternalPackages: ['better-sqlite3'],
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = config.externals || [];
      config.externals.push('better-sqlite3');
    }
    return config;
  },
};

export default nextConfig;
