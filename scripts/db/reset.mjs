#!/usr/bin/env node
/**
 * `npm run db:reset`, with the two things it was missing: a backup, and a
 * moment where someone has to mean it.
 *
 * `supabase db reset` drops the local database and re-seeds it. That is correct
 * behaviour and CI depends on it — replaying every migration from scratch is
 * how this repository proves its migrations actually work (.github/workflows).
 * Locally it is something else: it deletes the communities, collections and
 * members a developer created by using the app, and `auth.users` with them, so
 * their next sign-in creates a new account and the product looks like it lost
 * everything.
 *
 * That happened here on 2026-09-20. The developer reported it as a product bug
 * — their data vanishing whenever they signed back in — and it took a marker-
 * data investigation to establish that nothing in the stack was at fault: not
 * restarting Next.js, not restarting Supabase, not Docker, not the test suite.
 * Only this command, run by an agent who considered it routine.
 *
 * So it is no longer routine. This wrapper always takes a backup first, and
 * refuses to proceed unless the caller states the intent explicitly:
 *
 *   KOLEKTO_CONFIRM_RESET=yes npm run db:reset
 *
 * For applying migrations — the reason it was usually reached for — the right
 * command is `npm run db:migrate`, which changes the schema and keeps the data.
 */

import { spawnSync } from "node:child_process";
import process from "node:process";

const CONTAINER = process.env.KOLEKTO_DB_CONTAINER ?? "supabase_db_kolekto";
const CONFIRMED = process.env.KOLEKTO_CONFIRM_RESET === "yes";

function run(command, args, options = {}) {
  return spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32", ...options });
}

const containerUp = spawnSync("docker", ["exec", CONTAINER, "true"], { stdio: "ignore" }).status === 0;

if (containerUp) {
  console.log("Backing up first — a reset is not recoverable without one.\n");
  const backup = run("node", ["scripts/db/backup.mjs", `pre-reset-${new Date().toISOString().replace(/[:.]/g, "-")}`]);
  if (backup.status !== 0) {
    console.error("\nThe backup failed, so the reset is refused. Fix the backup before destroying anything.");
    process.exit(1);
  }
} else {
  console.log(`No running database container (${CONTAINER}) — nothing to back up.\n`);
}

if (!CONFIRMED) {
  console.error(
    [
      "",
      "Refusing to reset.",
      "",
      "This drops the local database and re-seeds it. Everything you created by",
      "using the app goes, including the account you sign in with.",
      "",
      "  To apply migrations and KEEP your data:   npm run db:migrate",
      "  To restore a backup afterwards:           npm run db:restore",
      "",
      "If you genuinely want a clean database:",
      "",
      "  KOLEKTO_CONFIRM_RESET=yes npm run db:reset",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

console.log("Resetting the local database.\n");
const reset = run("npx", ["supabase", "db", "reset"]);

if (reset.status !== 0) process.exit(reset.status ?? 1);

console.log("\nReset complete. The backup taken above can be restored with:  npm run db:restore");
