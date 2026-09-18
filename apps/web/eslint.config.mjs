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
const eslintConfig = [...nextCoreWebVitals, { ignores: [".next/**", "next-env.d.ts"] }];

export default eslintConfig;
