# Legacy migration exceptions and overflow design

Everything in legacy production that the new operational schema cannot represent,
with a destination for each. Nothing here is marked "not migrated" — see
[migration-data-loss-policy.md](migration-data-loss-policy.md).

Format per the brief: **SOURCE TABLE · SOURCE ROW TYPE · PROBLEM · PROPOSED
DESTINATION · PRESERVED FIELDS · PROVENANCE · RECONSTRUCTION STRATEGY.**

---

## 1. Blocking exceptions — these stop a clean migration

### X-1 · Collections have no community

**Source:** `collections` (275) · every row.
**Problem:** legacy `collections.user_id` points at an auth user. New
`collections.community_id` is `not null`. There is no community concept in legacy at
all.
**Destination:** `public.collections`, after creating one community per organizer.
**Preserved:** everything; `user_id` becomes an `officer_terms` owner row with
`start_reason='migration'`.
**Provenance:** `source_table='collections'`, `source_id`, `import_run_id`.
**Reconstruction:** a legacy collection is found by `source_id`; its organizer by
the community's owner term.
**Blocked on:** **F-L1** (community strategy).

### X-2 · Five collections have duplicate tier names

**Source:** `collections.price_tiers` · 23 duplicate-name groups across 5
collections.
**Problem:** the new schema enforces `unique (collection_id, lower(name))` (ADR
0010), added *because* legacy's `.find()` on id-or-name collapsed same-named tiers
onto one price and caused a payment incident.
**Destination:** `collection_tiers`, plus the original array verbatim in
`migration.legacy_collection.fields`.
**Reconstruction:** the original array is the record; the rows are the operational
form.
**Blocked on:** **F-L4** — rename during migration (changes what contributors saw),
or relax the constraint for imported rows (weakens the rule).

### X-3 · Three collections have contradictory type columns

**Source:** `collections` · 2 rows `type='tiered'`/`collection_type='fixed'` **with
real tiers**; 1 row `type='flat'`/`collection_type='ticket'` **with no tiers**.
**Problem:** the two columns disagree and the data supports one side in one case and
the other in the other.
**Destination:** `public.collections` once resolved; both original values always
preserved in `migration.legacy_collection.fields`.
**Blocked on:** **F-L3**. Three rows, individually reviewable.

### X-4 · `user_identity` holds national identity numbers

**Source:** `user_identity` (12) · NIN/BVN ciphertext, hashes, last-4.
**Problem:** the new `verification_records` is designed to store *a provider
reference and result*, not raw identity data. Migrating as-is contradicts the
design; dropping loses compliance evidence.
**Destination:** undecided.
**Blocked on:** **L-1, counsel.** The 5 KYC tables (174 rows) sit behind the same
question.

### X-5 · `payout_accounts` account numbers are encrypted with an unlocated key

**Source:** `payout_accounts` (26) · `account_number_cipher bytea`.
**Problem:** the decryption key's location is unknown. Without it the ciphertext is
preservable but not usable.
**Destination:** `withdrawal_accounts` (designed, unbuilt) + overflow.
**Reconstruction:** `account_last4` + `bank_code` + `bank_name` remain readable, so
an account is identifiable to a human without decryption.
**Blocked on:** **E-K1.**

---

## 2. Subsystem overflow — features the new product does not have

All of these go to **`migration.legacy_overflow`** (design in §4). Each retains its
full row as jsonb with `source_table` + `source_id` + `import_run_id`.

| # | Source tables | Rows | Problem | Reconstruction |
|---|---|---|---|---|
| X-6 | Ambassador programme: `ambassador_applications`, `_email_logs`, `_influenced_organizers`, `_payout_accounts`, `_profiles`, `_withdrawals` | 2 | No equivalent. `ambassador_profiles` carries `pin_hash` — **excluded per policy §3** | Full row jsonb minus the credential |
| X-7 | `campaigns`, `campaign_donations`, `campaign_images` | 2 | A **parallel fundraising entity** distinct from `collections`, with its own creator, story and target | Full row jsonb. **F-L2**: does a campaign become a collection, or stay history only? |
| X-8 | `campuses`, `students` | 47 | A campus/student directory with no equivalent | Full row jsonb |
| X-9 | Email engine: `email_campaigns`, `_recipients`, `_attachments`, `_audit_log`, `email_templates`, `email_test_sends`, `email_unsubscribes`, `email_change_requests` | 4,839 | No equivalent. 4,710 recipients is the bulk | Full row jsonb. **`email_unsubscribes` deserves attention**: suppression preferences are a compliance obligation, not a nicety |
| X-10 | `notifications` | 172 | New `notifications` designed, unbuilt | Full row jsonb |
| X-11 | `push_subscriptions`, `push_notification_events` | 186 | No equivalent. Subscriptions hold browser endpoint keys — treat as secrets | Redact the keys; preserve the rest |
| X-12 | `admin_users`, `admin_events` | 73 | `staff_users` designed (ADR 0009), unbuilt | Full row jsonb |
| X-13 | `password_change_otps`, `password_reset_otps` | 6 | Supabase Auth owns this now; OTPs are short-lived | Full row jsonb. Arguably worthless, preserved anyway |
| X-14 | `collection_access_grants`, `_invites`, `_invite_items`, `collection_transfer_requests` | 0 | Partially `officer_terms`/`invite_links`; transfer requests have no equivalent | Empty today — record "0 preserved" rather than omitting |
| X-15 | `verification_documents` | 1 | Pairs with the KYC question | Behind **L-1** |

---

## 3. Financial history exceptions

| # | Source | Rows | Problem | Destination |
|---|---|---|---|---|
| X-16 | `wallets` | 245 | Six mutable counters that **look like balances**. `net_payment` is ₦3.59 out | Preserved as history. **Never an opening balance.** |
| X-17 | `wallets_backup_20260805` | 240 | Forensic snapshot | `legacy_overflow` |
| X-18 | `payment_reference_backfill_snapshot_20260811` | 3,324 | Forensic snapshot | `legacy_overflow` |
| X-19 | `duplicate_void_snapshot_20260812` | 12 | Forensic snapshot; relates to the 14 `duplicate_voided` contributions | `legacy_overflow` |
| X-20 | `pending_payment_context` | 797 | Legacy payment state machine; its `reconciled` state conflates a verdict with a state | `legacy_overflow`. **Do not seed `payment_attempts`** |
| X-21 | `payment_recovery_log` | 30,242 | Largest table. Operational recovery attempts | `legacy_overflow` |
| X-22 | `payment_admin_actions` | 220 | Staff financial interventions, not FK-linked to withdrawals | `legacy_overflow` — real audit value |
| X-23 | `settlement_runs` | 56 | Nightly job audit | `legacy_overflow` |
| X-24 | `transfer_recipients` | 52 | **Plaintext** account numbers | `legacy_overflow`, **redacted to bank + last 4** |
| X-25 | `withdrawals.destination_account` | 292 | jsonb bank details | Redacted per [withdrawal model](legacy-withdrawal-model.md) §4. **L-3** |
| X-26 | `contributions` status `duplicate_voided` | 14 | A status with no new equivalent; ₦340,500 | Verbatim in `legacy_contribution.fields` |
| X-27 | `collections` status `paused` (4), `rejected` (1) | 5 | No new equivalent; `rejection_reason` must survive | Verbatim in `legacy_collection.fields` |
| X-28 | 12 soft-deleted collections | 12 | New schema needs `archived_at`; legacy has no deletion timestamp | **E-COL-1**: `updated_at` as proxy, or a new status. **Never `now()`** |

---

## 4. Proposed `migration.legacy_overflow`

**Not implemented.** The brief says to propose it and await instruction.

```sql
create table migration.legacy_overflow (
  id             uuid primary key default app.uuid_generate_v7(),

  -- Which project, which schema, which table, which row. `source_project` is what
  -- distinguishes a legacy-test rehearsal from a legacy-production run.
  source_project text        not null,
  source_schema  text        not null default 'public',
  source_table   text        not null,
  source_id      text        not null,   -- text: legacy PKs are not all uuid
                                         -- (campuses.campus_id, students.student_id)
  row_data       jsonb       not null,
  redacted_keys  text[],                 -- names of keys deliberately withheld
  import_run_id  uuid        not null
                 references migration.import_runs (id) on delete restrict,
  imported_at    timestamptz not null default now(),
  notes          text,

  constraint legacy_overflow_row_data_is_object check (jsonb_typeof(row_data) = 'object'),
  constraint legacy_overflow_source_id_not_blank check (length(btrim(source_id)) > 0)
);

create unique index legacy_overflow_source_key
  on migration.legacy_overflow (source_project, source_schema, source_table, source_id);
create index legacy_overflow_table_idx on migration.legacy_overflow (source_table);
```

Plus, matching the rest of the migration schema: RLS enabled **and** forced, a
`using (false)` policy, all privileges revoked from `anon` and `authenticated`, and
append-only via the existing `app.block_row_mutation()`.

**Four design points:**

1. **`source_id` is `text`, not `uuid`.** Legacy primary keys are not all UUIDs —
   `campuses.campus_id` and `students.student_id` are not. A `uuid` column would
   make those two tables unpreservable, which is the exact failure this table exists
   to prevent.
2. **`source_project` is on the row, not only the run.** Overflow may plausibly be
   loaded from both legacy projects, and a row must say which one it came from
   without a join.
3. **`redacted_keys` records what was withheld.** When a credential or an account
   number is deliberately not copied, the omission is itself recorded — so a future
   reader can tell "this field was empty" from "this field was withheld".
4. **The unique index makes it re-runnable**, the same
   `insert … on conflict do nothing` pattern as every other migration table.

---

## 5. Exception register summary

| Class | IDs | Count |
|---|---|---|
| **Blocked on FOUNDER** | F-L1, F-L2, F-L3, F-L4, F-L5, F-M1, E-COL-1 | 7 |
| **Blocked on LEGAL** | L-1 (`user_identity`/KYC), L-3 (bank details) | 2 |
| **Blocked on ENGINEERING** | E-P1 (`source_project`), E-W1 (`legacy_withdrawal`), E-O1 (`legacy_overflow`), E-K1 (decryption key) | 4 |
| **Manual review queue** | E-ID-2 (27 phone groups), X-3 (3 collections), X-2 (5 collections) | 3 |
| **Overflow, no decision needed** | X-6 … X-24 | 19 |

**Every one of the 53 legacy tables has a destination.** None is unaccounted for.
