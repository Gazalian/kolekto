import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The workspace packages ship TypeScript sources directly (no build step),
  // so Next.js must transpile them itself rather than expecting compiled JS.
  transpilePackages: ["@kolekto/ui", "@kolekto/validation", "@kolekto/domain"],
  // `next build` and `next dev` otherwise share `.next`, so a production
  // build taken while a dev server is running corrupts that dev server's
  // manifests (BUILD_ID, prerender-manifest.json, routes-manifest.json),
  // which then serves 404s until `.next` is cleared and the dev server is
  // restarted. Playwright's `webServer` (playwright.config.ts) sets
  // `NEXT_DIST_DIR=.next-e2e` so its build/start never touch `.next`, the
  // directory a concurrently running `next dev` owns.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
