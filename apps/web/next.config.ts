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
  // Baseline response headers, set before any page takes money.
  //
  //   · No framing by anyone, this origin included (the app frames nothing of
  //     its own), so a contribution or settings page cannot be overlaid by a
  //     hostile site — clickjacking. X-Frame-Options covers older browsers.
  //   · nosniff, so an uploaded cover image is never executed as script.
  //   · strict-origin-when-cross-origin, so a collection URL's path and query
  //     are not sent to a payment provider or any other origin on redirect.
  //   · HSTS without includeSubDomains or preload: those reach beyond this app
  //     and are a domain owner's decision. Browsers ignore it over plain HTTP,
  //     so local development is unaffected.
  //
  // Deliberately NOT a script/style Content-Security-Policy: one written before
  // the payment provider's checkout is chosen would have to be loosened for it,
  // and a wrong one breaks the page silently.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=31536000" },
        ],
      },
    ];
  },
};

export default nextConfig;
