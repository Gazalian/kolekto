/**
 * run-integration.ts — entry point of `npm run test:integration` (M13.2 Phase 1a; Phase 1c).
 *
 * Runs unconditionally: there is no "am I the main module" check that could
 * silently fail and exit 0. The configuration is read only from the repository
 * root's `.env.itest` (itest-env-file.ts); see itest-lane.ts for what the lane
 * enforces after that. Phase 4: exactly one of `--with-smtp` / `--without-smtp`
 * is required (`npm run test:integration -- --without-smtp`); there is no default.
 */

import { defaultEntryDeps, runIntegrationEntry } from "./itest-lane.ts";

process.exitCode = await runIntegrationEntry(defaultEntryDeps());
