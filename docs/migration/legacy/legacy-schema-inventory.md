# Legacy schema inventory — production

**Source:** `busfgcmbndleljklrcbd`, PostgreSQL 15.8.1.094, verified 2026-09-26.
Row counts live in [legacy-control-totals.md](legacy-control-totals.md); this
document covers **structure**.

---

## 1. Schema-level

| Schema | Tables | Views | Sequences | Note |
|---|---|---|---|---|
| `public` | 53 | 8 | 2 | the application |
| `auth` | 27 | 0 | 1 | Supabase Auth |
| `realtime` | 9 | 0 | 1 | Supabase |
| `storage` | 8 | 0 | 0 | Supabase |
| `cron` | 2 | 0 | 2 | **2 active jobs** |
| `net` | 2 | 0 | 1 | `pg_net`, used by cron job 5 |
| `supabase_migrations` | 1 | 0 | 0 | **39 versions** |
| `vault` | 1 | 1 | 0 | Supabase secrets |
| `extensions` | 0 | 4 | 0 | 10 extensions installed |

`public` also holds **2 enums, 0 domains, 9 triggers, 95 functions**.

**There are no domains.** The new schema's `app.kobo` has no legacy counterpart,
which is the root reason money is `numeric` throughout.

---

## 2. Migration tracking does not describe the schema

| Figure | Value |
|---|---|
| tracked versions | **39** |
| earliest | `20260514201017` (2026-05-14) |
| latest | `20260918101428` (2026-09-18) |
| earliest profile row | **2025-06-02** |

**Tracking begins roughly a year after the data does.** The schema was built before
migrations were recorded, so replaying the legacy migration files would not
reproduce production. The live database is the only authoritative description of
legacy production, and this baseline is the record of it.

This also means schema drift between legacy prod and legacy test cannot be assessed
from migration versions alone — it needs a structural comparison, which is Phase 12
and still pending.

---

## 3. Tables by class

**Core (4):** `collections` (40 cols), `contributions` (16),
`contribution_code_counters` (4), `profiles` (17).

**Financial (13):** `deposits` (23), `withdrawals` (11), `wallets` (13),
`payout_accounts` (12), `transfer_recipients` (9), `pending_payment_context` (26),
`settlement_runs` (9), `payment_recovery_log` (14), `payment_admin_actions` (11),
plus the 3 forensic snapshots and `wallets_backup_20260805`.

**Identity / compliance (7):** `user_identity` (10), `kyc_verifications` (13),
`kyc_documents`, `kyc_files`, `kyc_verification_history`, `verification_documents`,
`admin_users` (5).

**Subsystems with no new equivalent (21):** ambassador (6), campaigns (3),
campus/students (2), email engine (8), push (2).

**Operational (8):** `notifications` (12), `admin_events`,
`password_change_otps`, `password_reset_otps`, `collection_access_grants`,
`collection_access_invites`, `collection_access_invite_items`,
`collection_transfer_requests`.

---

## 4. Primary key types

Mostly `uuid`. Two exceptions that matter for the overflow design:

| Table | PK | Type |
|---|---|---|
| `campuses` | `campus_id` | **not uuid** |
| `students` | `student_id` | **not uuid** |
| `pending_payment_context` | `reference` | **`text`** |
| `contribution_code_counters` | `collection_id` | uuid (natural key) |
| everything else | `id` | uuid |

This is why `migration.legacy_overflow.source_id` is specified as `text` rather than
`uuid` — a `uuid` column would make `campuses` and `students` unpreservable, which is
the exact failure the overflow table exists to prevent.

---

## 5. RLS and policy coverage

| Figure | Value |
|---|---|
| tables with RLS **enabled** | **53 / 53** |
| tables with RLS **FORCED** | **3 / 53** |
| tables with **zero policies** | 28 |
| tables with policies | 25 |

The three FORCED tables are the forensic snapshots
(`payment_reference_backfill_snapshot_20260811`,
`duplicate_void_snapshot_20260812`, `payment_recovery_log`).

**RLS enabled with zero policies denies all row access to non-owner roles**, so the
28 policy-less tables are effectively service-role-only. That is a safe posture — but
it is also why the `anon` TRUNCATE grant matters so much: TRUNCATE is the one DML
verb RLS does not mediate. See
[legacy-production-baseline.md](legacy-production-baseline.md) §6 S1.

Most-policed tables: `campaigns` (9), `profiles` (8), `collections` (7),
`contributions` (6), `wallets` (6), `campaign_images` (5),
`verification_documents` (5).

---

## 6. Functions, triggers, views

**95 functions in `public`**, 20 SECURITY DEFINER, 59 anon-executable, 63
authenticated-executable, and **0 that are both SECURITY DEFINER and
anon-executable**.

**9 triggers** in `public` — a small number for a schema this size, which is
consistent with business logic living in application code rather than the database.
The new architecture inverts that deliberately.

**8 views, all SECURITY DEFINER, none granted to `anon`.** Six are payment
diagnostics: `v_payment_health_summary`, `v_payment_inbox`, `v_payment_invariants`,
`v_payment_mismatch_rate`, `v_payment_recovery_exhausted`,
`v_orphaned_successful_payments`. Plus `v_collections_with_duplicate_tier_names` and
`email_recipient_directory`.

Two of those view names are worth noting: the legacy team had already built
diagnostics for both hazards this baseline independently re-measured — duplicate tier
names, and orphaned successful payments.

---

## 7. What was not inspected

Column-level detail for all 53 tables was not extracted in full; the tables carrying
migration decisions were inspected column by column (`collections`, `profiles`,
`deposits`, `contributions`, `withdrawals`, `wallets`, `payout_accounts`,
`settlement_runs`, `pending_payment_context`, `payment_recovery_log`,
`payment_admin_actions`, `kyc_verifications`, `transfer_recipients`,
`user_identity`, `notifications`, `admin_users`, `contribution_code_counters`,
`campuses`, `students`, `campaigns`, `ambassador_profiles`).

Also not inspected: index definitions, check-constraint expressions, foreign-key
actions, sequence states, `storage` buckets and objects, and the
`scheduled-payment-recovery` Edge Function source (it lives outside the database).

None is required for the mapping decisions in this baseline. All are worth capturing
before the real migration, and all are read-only.
