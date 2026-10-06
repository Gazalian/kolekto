# Import foundations — report

**Date:** 2026-09-28 · **Milestone:** Migration Foundation (local-first sequence)

## IMPORT FOUNDATIONS COMPLETE — IMPORTER NOT YET BUILT

Every item in this milestone is done and tested locally. **No legacy data was
imported, no importer was built, and Migration Rehearsal #1 has not started.**

| | |
|---|---|
| Migrations added | **8** (81 → **89**), all forward-only, applied with `npm run db:migrate` — no reset |
| Local development data | **Intact** — 508 users, 990 communities, 370 collections, 357 members, identical before and after |
| Rows written to any `migration.*` table | **0** |
| Legacy Supabase projects | **Not touched.** Only the local D2 restore was read, in a read-only session |
| Staging | **Not touched.** 79 migrations, unchanged. No remote command was run |
| Paystack | **Not touched** |
| Real money moved | **None** |
| Tests | **1,121 passed, 0 failed, 0 skipped** + 6/6 invariants, typecheck, lint, build |

---

## 1. Migrations added

| Migration | Purpose |
|---|---|
| `20260928120000_import_runs_source_project` | `source_project` on every run, constrained; a run's identity is fixed and a finished run is frozen (E-P1) |
| `20260928120100_legacy_withdrawal` | `migration.legacy_withdrawal` — historical storage for the 292 legacy withdrawals (F-M2, E-W1) |
| `20260928120200_legacy_overflow` | `migration.legacy_overflow` — verbatim store for tables with no new shape (F-M3, E-O1) |
| `20260928120300_imported_objects_registry` | `migration.imported_objects` — which live row an import created from which source row (provenance) |
| `20260928120400_migration_history_immutability` | UPDATE/DELETE refused on the four history tables that lacked it (E-I1) |
| `20260928120500_truncate_guards` | TRUNCATE refused on 23 append-only and immutable tables (**F-4 closed**) |
| `20260928120600_importer_role` | `kolekto_importer` — NOLOGIN, INSERT/SELECT on `migration.*`, explicit RLS (E-R1, part 1) |
| `20260928120700_auth_user_import_context` | The sign-up trigger stands aside for a running import, and only then (E-T1) |

No existing migration was edited.

## 2. Tables added or changed

| Table | Change |
|---|---|
| `migration.import_runs` | **+ `source_project`** (NOT NULL, CHECK); `unique (id, source_project)` so rows can bind to their run's project by foreign key; guard trigger; corrected table comment |
| `migration.legacy_withdrawal` | **New.** Typed: `amount_kobo` (`app.kobo`), `original_status` (verbatim), original dates, legacy collection/user/wallet ids, provider transfer and recipient codes. Everything else in `fields`. **Refuses `destination_account`** (L-3) — only `destination_account_redacted` may be kept. `collection_id` is a nullable link; the legacy ids are the durable facts. Nothing references it, so it cannot feed a balance |
| `migration.legacy_overflow` | **New.** `source_table` (schema-qualified, any table), `source_id` **text** (uuid, integer or a documented composite), `source_key_columns`, `fields` jsonb. Eight columns and no business columns |
| `migration.imported_objects` | **New.** `source_table/source_id → target_table/target_id`, per run |
| `legacy_profile`, `legacy_collection`, `legacy_contribution`, `legacy_deposit` | + UPDATE/DELETE guards |
| 23 tables (§4) | + TRUNCATE guard |
| `app.handle_new_auth_user` | + import-context check; ordinary behaviour unchanged |

**Every new table** enables **and forces** RLS, denies `authenticated` and gives
`anon`, `authenticated` and `service_role` nothing. **Every new row carrying a
`source_project`** is bound to its run's `source_project` by a composite foreign key,
so a row cannot claim a different source from the run that imported it.

**Uniqueness, for deterministic re-import.** `legacy_withdrawal` and `legacy_overflow`
use `(source_project, source_table, source_id)`; `imported_objects` uses both
`(target_table, target_id)` and `(source_project, source_table, source_id,
target_table)`. The four older history tables keep their existing
`(source_table, source_id)` key. That allows one source project per database — right
for an isolated rehearsal target, and recorded here rather than changed.

## 3. Immutability protections

| Table | UPDATE | DELETE | Mechanism |
|---|---|---|---|
| `migration.legacy_profile` | refused | refused | **new** — `app.block_row_mutation()` |
| `migration.legacy_collection` | refused | refused | **new** |
| `migration.legacy_contribution` | refused | refused | **new** |
| `migration.legacy_deposit` | refused | refused | **new** |
| `migration.unattributed_payments` | refused | refused | existing, unchanged |
| `migration.legacy_withdrawal` | refused | refused | **new** |
| `migration.legacy_overflow` | refused | refused | **new** |
| `migration.imported_objects` | refused | refused | **new** |
| `migration.import_runs` | identity fixed; lifecycle only while `running`; frozen once finished | refused | **new** — `app.guard_import_run()` |

The guards are triggers, so they hold for **every** role, including the owner and
`service_role` — not just application roles.

**A consequence, stated plainly.** `legacy_collection.collection_id` and
`legacy_profile.user_id` were declared `ON DELETE CASCADE`. A cascade from a live row
now reaches a row that refuses deletion, so an imported collection or user cannot be
deleted. Imported collections were already undeletable (M9), and no code path
deletes a user (`public.users → auth.users` is `ON DELETE RESTRICT`). History
outliving its live row is the zero-data-loss requirement.

**A stale design statement corrected.** `import_runs`' comment said a run is
"reversible (delete by import_run_id)". That predates M9's append-only decision.
Rollback is discarding a rehearsal target, or PITR for a real run.

## 4. TRUNCATE protections — F-4 closed

A statement-level `BEFORE TRUNCATE` trigger, `app.block_truncate()`, on each table.
It holds for the table **owner** — the role no grant can restrict — and fires on
every table a `truncate … cascade` reaches.

| Class | Tables |
|---|---|
| Unconditionally append-only | `ledger_accounts`, `ledger_journals`, `ledger_entries`, `financial_events`, `financial_event_processing_attempts`, `financial_operation_claims`, `audit_logs`, `fee_schedules`, `fee_schedule_category_rates`, `withdrawal_fee_schedules`, `withdrawal_fee_brackets` |
| Conditionally immutable (TRUNCATE would destroy the protected rows) | `collections`, `members` (imported rows), `contributor_references` (issued references) |
| Imported history and its anchors | all nine `migration.*` tables |

The list comes from the existing triggers, not judgement. **Excluded:** `obligations`,
whose trigger validates paid status rather than making rows immutable. No
application path issues TRUNCATE, so no behaviour is removed.

Proved by `27_truncate_guards.sql`: all 23 refuse, as the owner; the guarded set is
asserted exactly, so it cannot silently shrink; an unguarded control table still
truncates.

## 5. Importer role design

**`kolekto_importer`** — `NOLOGIN`, `NOBYPASSRLS`, `NOSUPERUSER`, `NOCREATEROLE`,
`NOCREATEDB`. **No credential exists and none was created.** The migration
connection enters it with `SET ROLE` and leaves with `RESET ROLE`: `postgres` holds
membership `WITH SET TRUE, INHERIT FALSE`, so it must switch visibly and never
silently holds the role's rights.

### Implemented now — the `migration` schema

| Object | Privilege | RLS policy |
|---|---|---|
| `migration.import_runs` | SELECT, INSERT | may open a run only as `running` with no `completed_at` |
| the six history tables, `legacy_overflow`, `imported_objects` | SELECT, INSERT | a row lands **only into a run that exists and is `running`** |
| `app.uuid_generate_v7()` | EXECUTE | — the id default on every table; runs with the caller's rights |
| schemas `migration`, `app`, `extensions` | USAGE | — |

**Never, anywhere:** UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, any other
application function, any `service_role` privilege. `service_role` is unchanged —
still nothing on application tables (F-1 not reopened).

**The run lifecycle is not the importer's.** Closing a run is an UPDATE, done by the
orchestrating connection as itself.

### Proposed — the public schema, landing with the importer

Not granted yet, deliberately. Each insert into these tables fires triggers — slug
generation, audience derivation, immutability, validation — and whether those read
further tables *as the invoking role* can only be tested against real transform
output. Granting now would be granting on a guess.

| Destination | Proposed | RLS `with check` |
|---|---|---|
| `auth.users`, `auth.identities` | **Not the importer.** Inserted by the orchestrating connection, inside the import context (§7). The `auth` schema is platform-owned; this project does not grant on it | — |
| `public.users` | INSERT, SELECT | the id is an imported auth user in the running run |
| `public.communities` | INSERT, SELECT | `is_personal` and `type = 'personal'` only |
| `public.officer_terms` | INSERT, SELECT | `role = 'owner'` and `start_reason = 'migration'` only |
| `public.collections` | INSERT, SELECT | `is_imported` only |
| `public.members` | INSERT, SELECT | `is_imported` only |
| `collection_tiers`, `collection_fields`, `collection_code_sequences`, `public.legacy_links` | INSERT, SELECT | parent collection `is_imported` |
| Any ledger, financial, fee or audit table | **nothing** | — |

**A migration-only login role** is not proposed. For a local rehearsal the
connection is the local database owner. Whether a hosted rehearsal needs a dedicated
login is a question for the staging rehearsal, to be decided then — not a credential
to create silently now.

Proved by `28_importer_role.sql` (24 assertions): the attributes; the exact INSERT
and SELECT sets; zero UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER in six schemas;
exactly one executable function; no UPDATE/DELETE/ALL policy; and, acting as the
role, that it can open a run and write into it, but cannot write into a finished run,
UPDATE, DELETE or TRUNCATE history, close a run, read users or the ledger, write the
ledger, or execute application functions.

## 6. Provenance decisions

Not every table needs provenance columns. Each destination was classified:

| Class | Meaning | Tables |
|---|---|---|
| **A** | Direct provenance columns on the row | `collections`, `members` — existing (`is_imported`, `source_*`, `import_run_id`, `imported_at`; mandatory when imported) |
| **B** | Provenance through `migration.imported_objects` and the parent or run | `users` (also `legacy_profile.user_id`), `communities` (the personal community per organizer), `officer_terms` (also `start_reason = 'migration'`), `collection_tiers`, `collection_fields`, `collection_code_sequences`, `legacy_links` (also their parent's `is_imported`) |
| **C** | Live domain only — never written by an import | `contributor_references` (legacy codes stay in `legacy_contribution.fields` pending **A-1**), `obligations`, all ledger, financial, fee and audit tables, `invite_links`, `event_check_ins`, `member_groups` and the rest |
| **D** | Historical only, in `migration.*` | contributions, deposits, unattributed deposits, withdrawals, wallets and every other overflow table, profile and collection extras |

**Why a registry rather than columns:** adding `is_imported`/`source_*` to seven more
live tables would put a one-time migration concern into the permanent business
domain, and each would need its own immutability rule. One append-only registry
gives the same answers — "exactly which communities did run R create?" — and, with
its two uniqueness keys, makes a re-run find an organizer's existing community rather
than create a second.

## 7. Auth trigger and import strategy

**What happens today** (characterised by `29_auth_user_import_context.sql` Part 1,
which passed **before** any change): `app.handle_new_auth_user` fires `AFTER INSERT`
on `auth.users`, as `postgres`. For every row it creates a `public.users` row (name
from auth metadata or the email's local part; phone from `auth.users.phone`), **always
a new** personal community, and an owner term with `start_reason = 'created'`.

**Why that is wrong for an import:** the phone and name would come from auth metadata
rather than the legacy profile (F-M1); the owner term would be indistinguishable from
a real sign-up; nothing would record that the import made these rows; and correcting
any of it needs UPDATE, which the importer does not have.

| Considered | Verdict |
|---|---|
| `session_replication_role = replica` | **Rejected** — disables every trigger, including the immutability and validation ones the import most needs |
| Allow the trigger, reconcile afterwards | **Rejected** — needs UPDATE; the names, slugs and phones would be wrong first |
| Insert `public.users` first so `ON CONFLICT` keeps it | **Impossible** — `public.users.id` references `auth.users` |
| **Explicit, transaction-local import context** | **Chosen** |

**The decision.** The orchestrating connection runs
`select set_config('kolekto.import_run_id', '<running run id>', true)`. While that
names a **running** import run, the trigger creates nothing, and the importer creates
the three rows itself: the user from the legacy profile (F-M1), one personal community
per imported user (F-L1, preserving COM-01's one-per-user rule), and an owner term with
`start_reason = 'migration'`, each recorded in `imported_objects`.

| Context | Behaviour |
|---|---|
| unset or empty | ordinary sign-up — **unchanged for every real user** |
| names a running run | the trigger stands aside |
| malformed, unknown, or a finished run | **refused** — falling back would create exactly the uncontrolled objects the context exists to prevent |

It cannot be switched on from outside: using it needs the right to insert into
`auth.users` **and** to open an import run. No client role holds either (29, Part 4).
The `true` in `set_config` ends it with the transaction.

`29_auth_user_import_context.sql`: **8/14 before the migration** (the characterisation
passed; the six new behaviours failed), **14/14 after**. `07_application_write_functions.sql`,
which exercises the live sign-up bootstrap, still passes.

## 8. Conformance results

Full report: [legacy/REHEARSAL-1-CONFORMANCE-REPORT.md](legacy/REHEARSAL-1-CONFORMANCE-REPORT.md).
Read-only against the D2 restore, under the documented mapping (stated there as
M1–M13).

| Of 275 legacy collections | |
|---|---|
| **No constraint finding** | **230** |
| Mechanical only — resolved by the documented mapping | **22** |
| **Need a decision** | **23** |

| Finding | Rows | Collections |
|---|---|---|
| **F-L4** duplicate tier names | 23 groups | 5 |
| **E-COL-1** deleted → archived needs a timestamp | 12 | 12 |
| **E-COL-2 (new)** `rejected` has no new status | 1 | 1 |
| **Title** under 3 characters (new) | 1 | 1 |
| **Tier code prefix** — format (`FRONT-EN`, `UI/UX`) or duplicated within a collection (new) | 4 | 3 |
| **Tier quantity 0** (new) | 1 | 1 |
| Open-amount collections carrying a legacy amount (mechanical) | 23 | 23 |
| Advisories — zero fixed price (2), fixed collections holding tiers (2), a ticket collection with no tiers (1), tiers without a legacy id (58 collections) | — | — |

**Good news, measured:** every slug already fits the new format and none repeats
within an organizer, so the planned slug-normalisation work is unnecessary. No
description, story or tier name is too long; no amount is negative or imprecise;
every collection is NGN.

**Correction (superseded 2026-09-28 by [MIGRATION-DECISION-EVIDENCE.md §15](legacy/MIGRATION-DECISION-EVIDENCE.md)):**
137 was the count of tier entries whose `id` **JSON key was present**. The count that
matters for migration is entries whose `id` **value is non-empty**: **105 with a usable
id, 200 without**. The number claimed here — 137 of 305 tier entries carry a legacy id — is stated correctly as the JSON key count but is not the migration-relevant number; the corrected 105/200 supersedes any earlier reference to 137/168. Full correction of legacy-collection-model.md's "200 of
305 have none" as legacy-collection-model.md §4 states.

## 9. Test matrix

All run locally on 2026-09-28. **Nothing was skipped, weakened or deleted.**

| Suite | Result |
|---|---|
| Migrations, forward-only | **8/8 applied** with `npm run db:migrate`; no reset |
| pgTAP | **PASS — 29 files, 769 tests.** CLI exit **0**; no telemetry error this run |
| Invariants | **PASS — 6/6** |
| Domain | **PASS — 154/154** |
| Validation | **PASS — 58/58** |
| Provider + fake provider | **PASS — 37/37** |
| Config | **PASS — 20/20** |
| Web / unit | **PASS — 83/83** |
| Typecheck | **PASS — 0 errors** |
| Lint | **PASS — 0 problems** |
| Production build | **PASS** |

**Total: 1,121 tests passed, 0 failed, 0 skipped.** New this milestone: 26 (40), 27
(25), 28 (24), 29 (14) = **103 assertions**.

**Test changes to existing files, and why each is not a weakening:**

| File | Change |
|---|---|
| `06_migration_compatibility.sql`, `23_migration_fixtures.sql` | Their `import_runs` fixtures now supply `source_project`, which the schema now requires. Nothing else changed |
| `19_fee_schedules.sql` | The assertion "every fee-schedule table has both an update and a delete guard" counted **all** triggers on the four tables, so the new TRUNCATE guards broke it. It now counts the triggers running `block_fee_schedule_mutation` — what its description always said. Still expects 8; now **stricter**, since it checks the function |

**Failures I caused and fixed along the way:** a fixture in test 26 omitted a required
column; test 27's plan said 26 where there were 25 assertions; and a first draft of
test 26 contained a tautological "ledger unchanged" check, replaced with a real
before/after comparison before it ever ran.

**E2E (Playwright) was not part of this milestone's matrix** and was not run. The last
attempt, in the previous milestone, did not complete — see STAGING-ENVIRONMENT-VALIDATION.md §21.

## 10. Remaining founder decisions

| # | Decision | Rows |
|---|---|---|
| **A-6** | Real legacy data or synthetic data for Rehearsal #1, and whether real customer data may be loaded into a local database at all | — |
| **F-L4** | Duplicate tier names: rename during import, or relax `unique (collection_id, lower(name))` | 23 groups, 5 collections |
| **E-COL-1** | Archival timestamp for deleted collections (`updated_at` as proxy?) | 12 |
| **E-COL-2** *(new)* | A status for the one `rejected` collection, preserving `rejection_reason` | 1 |
| *(new)* | A 2-character title — shorten rule, or keep | 1 |
| *(new)* | Tier code prefixes that break the format or repeat within a collection | 3 collections |
| *(new)* | Tier `quantity = 0`: unlimited, or none? | 1 |
| **M7** | Confirm every legacy collection imports as open / public | 275 |
| **F-L2** | Legacy `campaigns`: a collection, or overflow only? | 1 |
| **A-1** | Must legacy contributor codes stay resolvable (e.g. check-in)? | — |
| **A-4** | Legacy avatar and banner URLs: copy, null, or wait for Storage | 13 |
| Advisories | Zero fixed price (2), fixed collections holding tiers (2), a ticket collection with no tiers (1) | 5 |

## 11. Remaining legal decisions

| # | Question | Effect |
|---|---|---|
| **L-1** | `user_identity` and KYC — may they migrate at all? | Exclude from Rehearsal #1 |
| **L-2** | Retention of 53 KYC documents | Exclude — Storage is out of scope anyway |
| **L-3** | Bank details | `legacy_withdrawal` now **refuses** full `destination_account`. `payout_accounts` and `transfer_recipients`: exclude, or overflow with redaction |

None blocks Rehearsal #1 if the excluded tables are recorded as excluded in the run's
notes.

## 12. Blockers before importer implementation

1. **Transform decisions that change code paths:** F-L4, E-COL-1, E-COL-2, the tier
   prefix rule, tier quantity 0, M7, A-1, A-4, F-L2. Each has specific rows now.
2. **Public-schema importer privileges** (§5, proposed matrix): grant, write the RLS
   policies, and test them against the triggers each insert fires. This is the first
   engineering task of the importer milestone, not a precondition outside it.

Nothing else. The destination tables, provenance registry, immutability, TRUNCATE
guards, the importer role and the auth import context all exist and are tested.

## 13. Blockers before Migration Rehearsal #1

1. **The importer** — built and passing against **synthetic** data first (ladder stage 2).
2. **E-TGT — an isolated local rehearsal target.** Not your development database: it
   holds your working data and must never be reset.
3. **A-6** — the data-source decision.
4. **E-REC** — the reconciliation queries of the validation contract, encoding every
   control total including the 359-kobo drift.
5. **Legal exclusions recorded** — L-1, L-2, L-3 tables named as excluded in the run's notes.
6. **Standing risk, unchanged:** the D1 backup is still **one unencrypted copy on one
   machine**. A rehearsal that reads it widens its use; encrypting it and making a
   second copy remains the highest-priority open preservation item.

**Not blockers:** staging (deliberately out of scope), hosting, Paystack, F-5 (the
application's connection role — recorded for the hosting milestone).

---

## State

| | |
|---|---|
| Branch / commit | `m8.1-financial-foundation` / `ce0b6db` (nothing committed) |
| Migrations | **89** in repository · **89** applied locally · **79** on staging (unchanged) |
| Local development data | **intact** |
| Legacy databases touched | **none** — only the local D2 restore, read-only |
| Staging touched | **no** |
| Paystack touched | **no** |
| Real money moved | **no** |

**IMPORT FOUNDATIONS COMPLETE — IMPORTER NOT YET BUILT.**
