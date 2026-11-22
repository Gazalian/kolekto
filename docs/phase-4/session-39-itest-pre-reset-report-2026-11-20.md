# Session 39 — integration-test database: pre-reset report

**Date:** 2026-11-20
**Status:** APPROVED and EXECUTED in session 40 — see [`session-40-itest-rebuild-report-2026-11-20.md`](session-40-itest-rebuild-report-2026-11-20.md). (Original pre-approval text below unchanged.)
**Scope:** Task 5 of the Session 39 brief (full pgTAP on a clean integration-test database).

## 1. What would be reset

| Item | Value | How known |
|---|---|---|
| Stack | `kolekto-itest` — the dedicated local Supabase integration-test stack (M13.2) | `supabase-itest/supabase/config.toml`, `scripts/itest/itest.mjs` |
| Database container | `supabase_db_kolekto-itest` (Postgres 17, host port 55422); **does not exist right now** (stack stopped, containers removed) | `docker ps -a`, `npm run itest:status` → `containers: none` |
| Database volume | `supabase_db_kolekto-itest`, 125.7 MB, created 2026-11-19 11:26:58 UTC | `docker volume inspect`, `docker system df -v` |
| Storage volume | `supabase_storage_kolekto-itest`, 0 B, created 2026-11-04 — **not touched** | same |
| Project ref | None. Local-only stack: no `[remotes]`, no link artifacts in `supabase-itest/supabase/.temp` (wrapper guard passed) | `npm run itest:status` |
| Database name | `postgres` inside the itest container; test role `kolekto_itest` | `itest.mjs` constants |
| Migration version | Copy in `supabase-itest/supabase/migrations`: 146 files, last `20261119100000_settlement_verified_charge_catchup.sql`. The volume dates from the 2026-11-19 rebuild with that copy, so the database is **probably** at `20261119100000`. **Not verified** — the stack cannot be started to read it (see §3). Source `supabase/migrations`: 149 files, last `20261120140000_withdrawal_approver_management.sql` (missing 3: `20261119120000`, `20261120100000`, `20261120140000`) | `npm run itest:status`, `ls` |

This is **not** the developer database (`supabase_db_kolekto`, port 54322), **not** staging and **not** the legacy production database. None of those is touched by anything below.

## 2. Existing data and whether any of it is valuable

- What it holds (from the M13.2 phase reports): run-tagged, inert residue from earlier integration-lane runs (test communities, test emails, audit rows) plus the wrapper's bootstrap (role `kolekto_itest`, stack-identity settings). The wrapper never links, pushes or uses a remote URL, so it has never held real user or production data.
- Valuable data: **none known.** The M13.2 docs already treat this residue as disposable and say that only `itest:reset` removes it.
- **Not verified live:** row counts could not be read because the stack cannot be started (§3). The cold backup in §5 covers this gap — nothing is lost for good even if something unexpected is in the volume.

## 3. Why `npm run itest:reset` cannot run as it is

- `itest:reset` first requires a **running** stack (`verifyRunningStack()` refuses when `supabase_db_kolekto-itest` does not exist).
- `itest:up` refuses to start it: the migration copy differs from `supabase/migrations` (146 vs 149 files) **and** the database volume exists (`up()`, "The migration copy differs … Run itest:reset").
- So the wrapper has no route from "stopped + out-of-date copy" to "reset". This is a gap in the wrapper, not damage.

## 4. Proposed procedure (no code change to the wrapper)

Run from the repository root, in PowerShell, only after approval:

1. `npm run itest:status` — confirm `containers: none`.
2. Cold backup (the stack is stopped, so the copy is consistent; uses the `postgres:17` image already on this machine, no download):
   ```powershell
   New-Item -ItemType Directory -Force C:\Users\USER\Desktop\Kolekto-codebase\itest-backups
   docker run --rm -v supabase_db_kolekto-itest:/v:ro -v C:\Users\USER\Desktop\Kolekto-codebase\itest-backups:/b postgres:17 tar czf /b/supabase_db_kolekto-itest-2026-11-20.tgz -C /v .
   ```
3. Move `.env.itest` into the backup folder (`.env.itest.2026-11-20`). Required: on a fresh volume the wrapper's `bootstrapOnce()` refuses a "partial bootstrap" when `.env.itest` exists but the role does not. The file holds only the old test-role password; it is never printed.
4. `docker volume rm supabase_db_kolekto-itest` — **this is the destructive step**: all integration-test data in that volume is deleted (recoverable only from step 2).
5. `npm run itest:up` — with no volume, `up` writes a fresh 149-file migration copy, starts the stack, applies every migration from zero, and bootstraps a new role password, stack ID and `.env.itest`.
6. `npm run itest:worker-role` and `npm run itest:net-lockdown` — recreate the test-only least-privilege worker role and the pg_net lockdown, which a fresh database does not have.
7. `npm run itest:status` — confirm 149/149 identical and the container identity.

Then (Task 5 proper): full pgTAP suite against the itest container, type checks, worker and web tests, and the concurrency script against a `kolekto_scratch_*` clone of the itest database. Every failure is classified.

**Alternative (not recommended):** change `itest.mjs` so `reset` can start the stack from the old copy first. It touches a safety wrapper and needs its own tests; the procedure above reaches the same end state using only existing commands.

## 5. Impact and rollback

- Impact: integration-test data only. No financial balance, no developer data, no staging or production database. The integration lane gets a new role password and stack ID (rotated, never shown).
- Rollback (if the old volume is ever needed): `npm run itest:down`; `docker volume rm supabase_db_kolekto-itest`; `docker volume create --label com.supabase.cli.project=kolekto-itest --label com.docker.compose.project=kolekto-itest supabase_db_kolekto-itest`; untar the backup into it with the same `postgres:17` image; restore `.env.itest.2026-11-20` as `.env.itest`; restore the 146-file migration copy from git at the matching commit. The wrapper's `up` then sees the old state.

## 6. Disclosure

While preparing this report, a faulty redaction filter in one inspection command printed the **current** `kolekto_itest` role password from `.env.itest` into the Session 39 chat transcript. It is a local, test-only credential for a database bound to 127.0.0.1. Step 5 above rotates it. It was not sent anywhere else.
