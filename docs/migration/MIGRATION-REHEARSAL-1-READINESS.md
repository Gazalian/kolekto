# Migration Rehearsal #1 — readiness

**Date:** 2026-09-28 · **Verdict: NOT READY — the rehearsal cannot safely begin.**

> **Update, same day — Import Foundations milestone.** Closed since this report:
> **E-W1** (`legacy_withdrawal`), **E-O1** (`legacy_overflow`), **E-P1**
> (`source_project`), **E-I1** (history immutability), **F-4** (TRUNCATE guards),
> **E-PV** (provenance registry), **E-T1** (auth import context), the first half of
> **E-R1** (`kolekto_importer`, migration schema), and **E-CONF** (conformance
> measured — 230 clean, 22 mechanical, 23 needing a decision). Still open: the
> importer itself, the isolated target, reconciliation, A-6 and the founder
> decisions now named row by row. Current status:
> [IMPORT-FOUNDATIONS-REPORT.md](IMPORT-FOUNDATIONS-REPORT.md) §12–§13.

**Founder sequence (2026-09-28):** local correctness → **local** migration rehearsal →
local reconciliation → review → host staging → staging golden path → rehearsal against
staging → production preparation. This report assesses step 2.

**Source of truth:** the verified D1 backup of legacy production
(`Kolekto-Preservation/2026-09-27-busfgcmbndleljklrcbd/`), already restored and
verified in the disposable D2 container `kolekto-legacy-restore` on `127.0.0.1:55432`.
**No legacy database is read.** Neither legacy project is touched.

## Summary

The destination design is largely right, and several gating decisions have been made
since the design was written. But **the rehearsal cannot begin, for a reason that
outranks every other: no import code exists.** The mapping document says so in its
own status line, and nothing has been written since.

Beyond that, four destination tables or protections are missing, the rehearsal has no
isolated local target, and four founder decisions and three legal questions remain
open. The legal questions can be kept out of Rehearsal #1 by excluding their tables;
the rest cannot.

| | Count |
|---|---|
| Ready | 14 items (§1) |
| Missing — engineering | 12 items (§2) |
| Ambiguous | 6 items (§3) |
| Founder decisions open | 6 (§4) |
| Legal decisions open | 3 (§5) |

## 1. What is ready

| Item | Evidence |
|---|---|
| **Source data, verified** | D1: 5/5 checksums; 20/20 control totals reproduce from the artefact |
| **Source restorable** | D2 PASS: 45/45 control totals, 80/80 foreign keys, 0 orphans, the 359-kobo drift reproduced. The container is still running |
| **Destination schema** | 81 migrations, applied locally; local test matrix in [STAGING-ENVIRONMENT-VALIDATION.md §21](STAGING-ENVIRONMENT-VALIDATION.md) |
| `migration.import_runs` | exists: `id, source_system, source_snapshot_label, status, started_at, completed_at, notes, created_by` |
| `migration.legacy_profile` / `_collection` / `_contribution` / `_deposit` | exist; verbatim `fields jsonb`, `(source_table, source_id)` unique |
| `migration.unattributed_payments` | exists; typed columns, **no `collection_id` by construction**, UPDATE/DELETE blocked by trigger |
| Provenance on `collections`, `members` | `is_imported`, `source_table`, `source_id`, `import_run_id`, `imported_at`; a CHECK makes provenance mandatory iff imported |
| Idempotent re-run | partial unique `(source_table, source_id) where is_imported` on `collections`, `members`; unique on every `migration.legacy_*` |
| Imported-row immutability | triggers on `collections`, `members` refuse UPDATE/DELETE of imported rows **for every role** |
| `public.legacy_links` | exists, for old slugs to keep resolving |
| `officer_terms.start_reason = 'migration'` | exists |
| **Email identity** | **F-2 fixed today.** Contributor deduplication across 3,353 legacy emails now treats case variants as one person — before the fix, `Ada@…` and `ada@…` would have become two members |
| **Least-privilege service role** | **F-1 fixed today.** No import path can rely on `service_role` |
| **Legacy connection guard** | **Fixed today.** `packages/config` refuses both legacy refs in every environment |

## 2. What is missing — engineering

| # | Missing | Why it blocks |
|---|---|---|
| **E-IMP** | **The importer itself.** No transform, loader or reconciliation code exists | Nothing to rehearse |
| **E-W1** | **`migration.legacy_withdrawal`** — approved as F-M2 | The 292 withdrawals (₦46.68m) have no destination |
| **E-O1** | **`migration.legacy_overflow`** — the verbatim store the destination matrix assigns 38 tables to | Everything outside the six directly mapped tables — **40,724 of the backup's 53,743 rows** across 47 tables, including `payment_recovery_log` (30,242), `pending_payment_context` (797) and `wallets` (245) — has no destination. Zero data loss (F-M3) cannot be met without it |
| **E-P1** | `source_project` on `migration.import_runs` | Without it a rehearsal run and a real run are indistinguishable in the data |
| **E-I1** | **Immutability triggers on `migration.legacy_profile`, `_collection`, `_contribution`, `_deposit`** | Only `unattributed_payments` of the six migration tables refuses UPDATE/DELETE. "Imported history is immutable history" is not yet true for the other four |
| **F-4** | **`BEFORE TRUNCATE` guard on append-only tables** | `TRUNCATE` skips row triggers. None of the 15 protected tables blocks it; the owner role can empty them. See [SERVICE-ROLE-PRIVILEGE-DECISION.md §4](SERVICE-ROLE-PRIVILEGE-DECISION.md) |
| **E-R1** | **A dedicated importer role** (`kolekto_importer`, NOLOGIN, INSERT-only on destinations, explicit RLS policies) | Every table forces RLS; the importer needs a stated, least-privilege way through. Design in the decision report §5 |
| **E-T1** | **A decision on the sign-up trigger during import** | Inserting into `auth.users` fires `app.handle_new_auth_user`, which creates a `public.users` row, a **personal community and an owner term for every one of 623 users**. Consistent with COM-01 and with F-L1, but those communities carry **no provenance** (`communities` has no provenance columns) and their names derive from auth metadata |
| **E-PV** | **Provenance on `users`, `communities`, `collection_tiers`, `contributor_references`, `officer_terms`** | Imported rows in these tables are indistinguishable from new ones. Reconciliation and a clean retry depend on telling them apart |
| **E-TGT** | **An isolated local rehearsal target** | The local stack holds your working data (503 users, 983 communities, 368 collections). Rehearsing into it would mix legacy and development data, pollute every reconciliation count, and risk email and slug collisions. It must not be reset (a reset destroyed work on 2026-09-20). A second local Supabase stack on different ports, or an equivalent disposable instance, is needed |
| **E-CONF** | **A conformance pre-flight against the D2 restore** | Imported collections must satisfy **24 check constraints** — name length, slug format, story lengths, `fixed_has_amount_once_published`, `published_consistently`, `audience_matches_participation` and more. How many of 275 legacy collections pass is **unmeasured**. Measure it read-only against `kolekto-legacy-restore` before writing the transform |
| **E-REC** | **Reconciliation queries encoding the validation contract** | [migration-validation-contract.md](../phase-4/migration-validation-contract.md) §2–§3 specify them; none are written |

## 3. What is ambiguous

| # | Question | Why it matters |
|---|---|---|
| A-1 | **Legacy contributor codes** (`contributions.contributor_unique_code`, e.g. `FCYB-001`) | The new `contributor_references` is issued against **obligations**, and imported contributions become history, not obligations. So legacy codes survive only inside `legacy_contribution.fields`. If any **live** legacy ticket collection needs check-in by its old codes, that fails. Which collections are still live on the day matters |
| A-2 | **Collection items** | Legacy has **no items concept** — only `price_tiers`, `ticket_mode`, `allow_multiple_quantity`. `collection_items` receives nothing. Confirm that is intended |
| A-3 | **Tiers that do not fit `collection_tiers`** (F-M3 in the contract) | 200 of 305 tier entries have no `id`. The mapping has no overflow destination for a tier that fails the shape |
| A-4 | **Avatar and banner URLs** | 12 `profiles.avatar_url` and 1 `collections.banner_url` point at **legacy Storage**. Copying the URL creates a dependency on a project due to be disconnected; nulling it loses the reference; migrating the file is D6/B5, deliberately deferred |
| A-5 | **Images embedded as base64 in the database** | 6 rows (`campaigns.main_image_url`, `campaign_images.image_url`, `verification_documents.document_url`, 3 × `collections.banner_url`) are `data:` URIs, ~2.7 MB. They live in the D1 backup, not Storage, so a Storage-based step would miss them. Overflow or new-schema field? |
| A-6 | **What "Rehearsal #1" loads** | The existing ladder puts a **synthetic, production-shaped** set (stage 2) before any real data. The founder sequence names a local rehearsal and the backup as the source. Loading real customer data — 622 profiles, 3,353 contributor identities, bank-detail ciphertext — into a local database is the data-protection question (O-10) the runbook says "must not happen casually". The D1 artefact is already on this machine, **unencrypted, single copy**; loading it into a running app database widens that exposure |

## 4. Founder decisions

**Decided — recorded so they are not re-opened:**

| # | Decision |
|---|---|
| F-M1 | Every authenticated user retained; phone from `profiles.phone_number`; none invented |
| F-M2 | Create `migration.legacy_withdrawal` (engineering: **E-W1, not built**) |
| F-M3 | Zero data loss |
| F-L1 | One personal community per production organizer |
| F-L3 | `collections.collection_type` authoritative; `type` preserved as provenance |
| F-L5 | Legacy `approved` = terminal paid; `success` = retired vocabulary for the same outcome; originals preserved |
| F-L6 | The test-workspace prototype is not production customer history |
| — | Wallets are never opening balances; the new ledger starts at zero; no KYC, Storage, partial-payment or refund migration; the ₦19.8m unattributed matter is closed |

**Open:**

| # | Decision needed | Blocks |
|---|---|---|
| **F-L2** | Are the legacy `campaigns` (1 row) a collection, or overflow only? | Its destination |
| **F-L4** | **The 5 collections with duplicate tier names** (23 groups). Rename during import, or relax `unique (collection_id, lower(name))`? This is the tier shape behind the 2026-08-06 payment-loss incident | Those collections' tiers |
| **E-COL-1** | **The 12 deleted collections.** New collections require `archived_at` when archived; legacy records no deletion time. Which timestamp stands in? | Those 12 rows |
| **A-6** | **Real data or synthetic data for Rehearsal #1**, and whether real customer data may be loaded into a local database at all | Whether the rehearsal may begin |
| **A-1** | Must legacy contributor codes stay resolvable operationally (e.g. for check-in)? | Scope of E-IMP |
| **A-4** | Avatar and banner URLs: copy, null, or wait for Storage | `users.avatar_url`, one banner |

## 5. Legal decisions

| # | Question | Effect on Rehearsal #1 |
|---|---|---|
| **L-1** | `user_identity` (12, NIN/BVN ciphertext) and KYC tables — may they migrate at all? | **Exclude** from Rehearsal #1. Nothing else depends on them |
| **L-2** | Retention of 53 KYC documents | **Exclude** — Storage is out of scope anyway |
| **L-3** | Bank details: `payout_accounts` (26, ciphertext), `transfer_recipients` (52, **plaintext**) | **Exclude**, or overflow with `transfer_recipients` redacted to bank + last 4 |

**None of the three need block Rehearsal #1** if their tables are excluded and the
exclusion is recorded in the run's notes as deliberate, not lost.

## 6. Engineering decisions

E-T1 (sign-up trigger during import), E-R1 (importer role design), E-TGT (target
isolation), and the order of E-W1/E-O1/E-P1/E-I1/F-4 relative to the importer. All are
listed in §2; none needs anything outside engineering.

## 7. Source → destination mappings

Authoritative detail: [legacy-to-new-mapping.md](legacy/legacy-to-new-mapping.md). Status
as of today:

| Legacy source | Rows | Destination | Ready? |
|---|---|---|---|
| `auth.users` | 623 | `auth.users`, **UUID preserved** | Table yes; **E-T1** open |
| `auth.identities` | 623 | `auth.identities` | yes |
| `profiles` | 622 | `public.users` (+ extras → `migration.legacy_profile`) | yes; **A-4**, **E-PV** |
| Organizer → community | per organizer | personal community + owner term (`start_reason='migration'`) | decided (F-L1); **E-T1**, **E-PV** |
| `collections` | 275 | `public.collections` (+ extras → `legacy_collection`) | table yes; **E-CONF**, **F-L4**, **E-COL-1** |
| `collections.collection_type` / `type` | 275 | `category` + `amount_model` + `participation_mode` | decided (F-L3) |
| `collections.price_tiers` | 305 / 79 collections | `collection_tiers` | **F-L4**, **A-3** |
| Items | — | `collection_items` | **A-2** — no legacy source |
| `collections.slug` | 275 | `collections.slug` + `legacy_links` | yes |
| Deleted collections | 12 | `collections`, `status='archived'` + `archived_at` | **E-COL-1** |
| `contribution_code_counters` | 53 | `collection_code_sequences` | yes |
| Contributors | 3,353 distinct emails | `public.members`, `unclaimed` | yes; **F-2 was a prerequisite, now fixed** |
| Contributor codes | per contribution | inside `legacy_contribution.fields` only | **A-1** |
| `contributions` | 5,576 | `migration.legacy_contribution` | table yes; **E-I1** |
| `deposits` with collection | 4,884 | `migration.legacy_deposit` | table yes; **E-I1** |
| `deposits` without collection | 1,317 | `migration.unattributed_payments` — never attributed | **yes** |
| `withdrawals` | 292 | `migration.legacy_withdrawal` | **E-W1 — missing** |
| `wallets` | 245 | `migration.legacy_overflow` — **never a balance** | **E-O1 — missing** |
| 46 other tables | 40,479 | `migration.legacy_overflow`, less the legal exclusions below | **E-O1 — missing** |
| KYC, `user_identity`, bank details | — | excluded from Rehearsal #1 | legal (§5) |
| Storage objects | 68 | not migrated (D6) | deferred |
| Ledger | — | **nothing — the new ledger starts at zero** | by rule |

## 8. Reconciliation controls planned

From [migration-validation-contract.md](../phase-4/migration-validation-contract.md) and
[legacy-control-totals.md](legacy/legacy-control-totals.md). **Specified, not yet coded.**

| Control | Target |
|---|---|
| Row counts, source vs destination, per entity | exact match, or an itemised exception |
| `auth.users` | 623, same UUIDs |
| `public.users` | 622 from profiles (+1 auth user with no profile, E-ID-1) |
| `collections` | 275 imported; by status: active 237, closed 21, deleted 12 → archived, paused 4, rejected 1 |
| `legacy_contribution` | 5,576; paid 3,934 = **4,606,968,935 kobo** |
| `legacy_deposit` + `unattributed_payments` | 4,884 + 1,317 = 6,201; all-deposit gross **9,002,064,126 kobo**; unattributed success 923 = **1,979,922,000 kobo** |
| `legacy_withdrawal` | 292 = **4,668,287,280 kobo** |
| `wallets` in overflow | 245; available **11,403,830 kobo**; **the 359-kobo drift must reproduce** |
| New ledger | **0 journals, 0 entries** after import |
| Referential | every imported collection has a community; every member a community; 0 orphans |
| Idempotency | a second run of the same import changes nothing |
| Immutability | an UPDATE or DELETE of any imported row is refused |

A rehearsal passes only if every control reproduces from the **imported** data — the
same standard D2 met from the restore.

## 9. Rollback strategy

| Scenario | Rollback |
|---|---|
| Any failure in a local rehearsal | **Discard the rehearsal target** and recreate it (E-TGT). Nothing else is touched |
| Failure mid-run, resumable | Resume with the same run id; `(source_table, source_id)` uniqueness makes re-insertion a no-op |
| Structurally valid but wrong data | Never edited. A new run with corrected provenance |
| Legacy | Nothing to roll back — read only through the backup, never connected |
| Your local development database | **Never a rehearsal target**, so never at risk |

This is why E-TGT matters: with an isolated target, rollback is "delete it". Without
one, the only rollback would be a reset, which is prohibited here for good reason.

## 10. Can the rehearsal safely begin?

**No.**

**Hard blockers, in the order they should close:**

1. **A-6** — founder: real data or synthetic, and whether real customer data may be
   loaded locally.
2. **E-TGT** — an isolated local rehearsal target.
3. **E-W1, E-O1, E-P1, E-I1, F-4** — the missing tables and protections, as forward
   migrations with pgTAP, local first.
4. **E-CONF** — measure conformance of the 275 legacy collections against the new
   constraints, read-only against the D2 restore.
5. **F-L4, E-COL-1, F-L2** — founder rulings for the rows E-CONF will surface.
6. **E-R1, E-T1** — importer role and sign-up-trigger handling.
7. **E-IMP, E-REC** — the importer and its reconciliation.

**Not blocking, provided their tables are excluded and the exclusion recorded:**
L-1, L-2, L-3, Storage, KYC.

**Recommended next milestone: "Import foundations"** — items 2–4 above. None needs a
decision beyond A-6, and E-CONF will turn the remaining founder questions from
hypothetical into specific rows.
