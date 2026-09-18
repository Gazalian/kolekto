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
    include: ["lib/**/*.test.ts"],
    environment: "node",
  },
});
