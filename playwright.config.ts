import { defineConfig, devices } from "@playwright/test";

/**
 * Browser-level tests (section 24). Run against `apps/web`'s dev server on
 * top of the local Supabase stack (`npm run db:start`) — these are the tests
 * that actually drive a browser through the OTP sign-in flow, using Mailpit
 * (the local stack's mail catcher, `MAILPIT_URL` from `supabase status`) to
 * read the code the way a real inbox would, rather than mocking auth away.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 1,
  // Same reasoning as `expect.timeout` below: the 8-step golden path
  // comfortably clears the default 30s per-test budget on a normally
  // resourced machine, but not sharing 4 CPUs with a full Supabase stack.
  timeout: 60_000,
  // The default 5s expect timeout produced flaky failures on the resource-
  // constrained sandbox this suite was authored on (a full Supabase stack
  // plus Next.js plus the browser sharing ~4 CPUs / 4GB RAM).
  //
  // Raised from 15s to 30s when Phase 3's journeys joined the suite. The
  // failure it fixes looked exactly like a product bug and was not: a sign-in
  // whose OTP request took longer than 15s under three specs' worth of load,
  // while the same request from a plain browser against the same stack
  // answered in about a second. Measured, not guessed — 30s is still short
  // enough that a genuinely hung request fails the run rather than stalling
  // it for the full per-test budget.
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3010",
    trace: "retain-on-failure",
  },
  webServer: {
    // The production build, not `next dev`: Turbopack dev mode's HMR
    // WebSocket failed its handshake in the sandbox this suite was authored
    // in, which broke client-side hydration entirely (every onClick silently
    // did nothing) — a dev-tooling problem specific to that environment, not
    // this application; `next build && next start` sidesteps it and is also
    // closer to what a CI run should exercise anyway.
    command: "npm run build --workspace apps/web && npm run start --workspace apps/web -- -p 3010",
    url: "http://127.0.0.1:3010",
    reuseExistingServer: true,
    timeout: 180_000,
  },
  // `channel: "chromium"` forces the full Chromium binary rather than the
  // separate `chromium_headless_shell` build Playwright otherwise launches
  // for headless runs — kept explicit because the shell build failed to
  // download in this environment while full Chromium succeeded.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: "chromium" } }],
});
