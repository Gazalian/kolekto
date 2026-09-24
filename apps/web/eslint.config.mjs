import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

/**
 * A real lint configuration, replacing the placeholder `echo` the Phase 1
 * root `lint` script ran — Phase 1.5's own report flagged that as a gap
 * still open ("lint... technically exited successfully because a proper
 * lint configuration did not yet exist"). `core-web-vitals` brings in the
 * accessibility rules (jsx-a11y) section 21 asks for as a baseline, not a
 * later pass.
 *
 * Imported directly rather than through `FlatCompat` (the older
 * `.eslintrc`-compatibility shim): this version of `eslint-config-next`
 * already exports native flat-config arrays, and `FlatCompat` re-normalising
 * an already-flat config is what produced a circular-structure crash from
 * `@eslint/eslintrc` against this ESLint version.
 */
const eslintConfig = [
  ...nextCoreWebVitals,
  // `.next-e2e/**` is the isolated production-build output Playwright's
  // webServer writes (next.config.ts `distDir`, playwright.config.ts), kept
  // out of `.next/**` so it doesn't collide with a running `next dev`
  // server. It needs the same lint ignore `.next/**` already gets.
  { ignores: [".next/**", ".next-e2e/**", "next-env.d.ts"] },
];

export default eslintConfig;
