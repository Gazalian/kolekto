# Migration validation contract

**No migration is successful because the SQL completed.** It is successful when
it can account for every record it was given.

**Opened:** 2026-09-24 (M8.2)
**Fixtures:** `supabase/tests/23_migration_fixtures.sql` — the canonical synthetic
legacy shapes, all 43 assertions passing
**Companions:** [environments](environments.md) ·
[financial decisions](financial-decisions.md)

---

## Why this document exists

The old estate's reconciliation was a tool somebody ran when something looked
wrong, and its own root-cause report opens by saying the author could not run it.
When it was finally run it found 48 of 57 collections with balance drift, and
establishing that no money had actually been lost then took a code audit — because
the comparison could say *that* two numbers disagreed and not *why*.

A migration has the same failure mode, worse: it runs once, against real history,
and a silent loss is discovered months later by the person whose record is gone.
So the contract is that a run **produces a report**, and the report is the
deliverable rather than the exit code.

---

## 1. Every run is identified

`migration.import_runs` already exists and carries what is needed:

| Column | Why it matters |
|---|---|
| `id` | every imported row points at it, so a run's output is exactly enumerable |
| `source_system` | which system was read |
| `source_snapshot_label` | **which snapshot** — this is what distinguishes a re-run from a first run |
| `status` | `running` / `completed` / `failed` / `rolled_back` |
| `started_at`, `completed_at` | duration, and whether it ever finished |
| `notes` | free text for the operator |

A run that ends `running` for ever is a failed run that nobody closed, and that
must be visible rather than inferred from a timestamp.

## 2. Counts, source against target

Each row of this table is a number the run must produce and a number somebody must
read. A mismatch is not automatically a failure — some are expected and
explainable — but an **unexplained** mismatch blocks the run being called
complete.

| Entity | Source | Target | Expected relationship |
|---|---|---|---|
| Auth users | legacy `auth.users` | `auth.users` | **equal**, and every UUID preserved |
| Profiles | legacy `profiles` | `public.users` | equal, or short by profiles with no auth row — each one listed |
| Organiser identities | legacy organisers | `officer_terms` with `start_reason = 'migration'` | equal |
| Communities | legacy groups/organisations | `public.communities` | equal |
| Collections | legacy `collections` | `public.collections where is_imported` | **equal, including archived and deleted** |
| Collection slugs | legacy slugs | `collections.slug` + `legacy_links` | every old slug resolves |
| Tiers / options | legacy tier rows or jsonb | `collection_tiers` | equal per collection |
| Custom fields | legacy custom fields | `collection_fields` | equal per collection |
| Contributors | legacy contributors | `public.members where is_imported` | equal; **none becomes an auth user** |
| Paid contributions | legacy `contributions where paid` | `migration.legacy_contribution` | **equal**, and grouped by original status |
| Pending contributions | legacy `contributions where pending` | `migration.legacy_contribution` | equal |
| Deposits | legacy `deposits` | `migration.legacy_deposit` | equal |
| Withdrawals | legacy withdrawals | **no destination table exists** | **see finding F-M2** |
| Unattributed payments | legacy payments with no collection | `migration.unattributed_payments` | equal; **none acquires a collection** |
| Contributor references / codes | legacy codes | `contributor_references` or `legacy_links` | every code still resolves, none reissued |

## 3. Financial totals

Reported, and **never** posted.

| Figure | How it is produced |
|---|---|
| Total imported paid contribution value | `sum` over `migration.legacy_contribution` fields, by original status |
| Total imported deposit value | `sum` over `migration.legacy_deposit` |
| Total unattributed value | `sum(amount_kobo)` over `migration.unattributed_payments` |
| **Ledger entries created by the import** | **must be exactly zero** |
| **Ledger journals created by the import** | **must be exactly zero** |
| **Opening balances created** | **must be exactly zero** |

The last three are the hard ones. The old `wallets` table held five mutable
numbers per collection and they are the most tempting thing to carry across,
because they look like balances. They were a cache — `ledger_balance` was a
derived figure with no entries behind it. Turning them into opening balances would
put numbers in the new ledger that no entry explains, which is the precise
property this architecture exists to prevent (D-23).

`23_migration_fixtures.sql` asserts all three against a full set of imported
fixtures, so "the import created no financial truth" is a checked fact.

## 4. Exception categories

Every record that does not land cleanly belongs to exactly one category, and each
category has a named owner and a resolution path. A record in none of them is a
gap in this contract.

| Category | Meaning | Resolution |
|---|---|---|
| `requires_manual_review` | imported, but a human must look | operations queue |
| `orphaned` | references a parent that does not exist in the target | investigate before the parent is invented |
| `duplicate` | two legacy rows claim one identity | the duplicate-phone groups are a known instance |
| `id_not_preserved` | the original identifier could not be kept | **must be empty for auth users** |
| `unattributable` | no collection can be established | preserved as-is; **never guessed** |
| `status_unmappable` | a legacy status has no equivalent | kept verbatim in the overflow `fields` |
| `skipped` | deliberately not imported, with a reason | the reason is the deliverable |

## 5. What makes a run re-runnable

The property that makes a migration safe to attempt twice, which is what you
actually need when the first attempt fails halfway:

- `(source_table, source_id)` is **partial-unique where `is_imported`** on
  `collections` and `members`, so `insert … on conflict do nothing` is an enforced
  guarantee rather than an assumption about the pipeline.
- The overflow tables carry the same uniqueness on `(source_table, source_id)`.
- Provenance is mandatory when `is_imported` and **forbidden otherwise**, by
  `CHECK`, so a row the new platform created can never wear provenance it does not
  have, and a half-claimed import is refused.
- Imported rows are immutable, so a second run cannot quietly change what the
  first one wrote.

All four are asserted by `06_migration_compatibility.sql` and
`23_migration_fixtures.sql`.

## 6. The report a run must emit

Not a log. A document, retained, that a non-engineer can read:

1. Run identity: id, snapshot label, start and end, final status.
2. The §2 count table, source against target, with every mismatch explained.
3. The §3 financial totals, including the three zeros.
4. Exception counts per §4 category, with a record list for each non-zero one.
5. Preserved-identity confirmation: auth UUIDs equal in source and target.
6. An explicit statement that no ledger row was created.
7. Sign-off: who read it and accepted it.

**A run with no report is not a completed run**, whatever `status` says.

## 7. Rehearsal requirement

The first time this contract runs against real data must not be the first time it
runs at all.

| Stage | Data | Where |
|---|---|---|
| 1 | Synthetic fixtures (`23_migration_fixtures.sql`) | local — **done, 43 assertions passing** |
| 2 | A larger synthetic set, shaped like production volumes | local |
| 3 | A read-only snapshot of legacy **test** data | staging, after F-E1 |
| 4 | A read-only snapshot of legacy **production** data | staging — rehearsal only, never written back |
| 5 | The real run | new production, with the rollback plan of gate P6 |

Stage 4 is the one that matters and the one that needs care: it means taking a
snapshot of live data into staging. That has its own data-protection question
(O-10, retention and residency) and must not happen casually.

## 8. Open findings from M8.2

| # | Finding | Needs |
|---|---|---|
| **F-M1** | `members_active_has_phone` means a legacy person with no phone cannot be imported as an `active` member. For contributors this is right — they are `unclaimed`. For a legacy **authenticated user** with no phone, the migration must choose a roll status. | FOUNDER |
| **F-M2** | There is **no destination table for legacy withdrawals.** `migration.legacy_deposit` and `legacy_contribution` exist; there is no `legacy_withdrawal`. The architecture's own history table says withdrawals are "preserved as history", so the intent exists and the table does not. | ENGINEERING — add in the migration-engine milestone; it is additive |
| **F-M3** | No destination for legacy **auth users** or **tiers** as overflow rows. Both are representable in target tables, so this may be deliberate — but a legacy tier whose shape does not fit `collection_tiers` has nowhere to go. | ENGINEERING — confirm before the transform is written |
