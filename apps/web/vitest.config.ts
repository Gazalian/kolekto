import { defineConfig } from "vitest/config";

/**
 * Unit tests for `apps/web`'s pure helpers only. Server actions and Server
 * Components are exercised by `tests/e2e` against the real stack instead of
 * being mocked here — a mocked Supabase client proves the mock behaves, not
 * that RLS or a permission check does (the previous system's problem was
 * never a lack of tests that mocked the database).
 */
export default defineConfig({
  test: {
    // Plus the pure data modules that live beside the routes they describe —
    // the export catalogue is one, and it is worth pinning where it is read.
    include: ["lib/**/*.test.ts", "app/**/*.test.ts"],
    // A PDF of a thousand rows is real work, and it is the case worth testing.
    testTimeout: 30_000,
    environment: "node",
  },
});
