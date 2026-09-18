import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The workspace packages ship TypeScript sources directly (no build step),
  // so Next.js must transpile them itself rather than expecting compiled JS.
  transpilePackages: ["@kolekto/ui", "@kolekto/validation", "@kolekto/domain"],
};

export default nextConfig;
