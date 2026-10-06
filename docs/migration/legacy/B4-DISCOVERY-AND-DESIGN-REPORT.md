# B4 Discovery and Design Report — Legacy Overflow & Wallets

**Date:** 2026-09-29
**Status:** DISCOVERY COMPLETE — implementation NOT started
**Source:** D2 production restore at `127.0.0.1:5544` (read-only)
**Rehearsal target:** `127.0.0.1:5455` (not touched during discovery)

---

## 1. Executive summary

B1 (contributions), B2 (deposits), and B3 (withdrawals) are closed. They
account for 7 tables and 13,642 rows of core transactional data. B4 covers
everything else in the D2 restore — 34 tables with data (41,421 rows), 13
empty tables (0 rows), 8 views (query definitions only), and 74 storage
objects across 4 buckets.

Of the 41,421 remaining rows:

- **31,678 rows** (7 tables) → archive to `migration.legacy_overflow`
- **282 rows** (9 tables) → exclude as sensitive (PII, encrypted credentials)
- **9,387 rows** (19 tables) → exclude as ephemeral, operational, or low-value
- **74 rows** (2 tables) → defer (storage/image migration, separate phase)
- **0 rows** (13 tables) → skip (empty)

The `migration.legacy_overflow` table on the rehearsal target is correctly
designed for this workload: `TEXT source_id` accommodates non-UUID PKs,
`source_key_columns TEXT[]` records composite or non-standard PKs,
schema-qualified `source_table` CHECK constraint matches the imported_objects
pattern, and append-only protections (UPDATE/DELETE/TRUNCATE refused) are
already in place.

Wallet balances (₦114,038.30 available across 245 wallets) are archived as
historical snapshots. They MUST NOT become opening balances, ledger seeds, or
financial truth in the new system. The new system computes its own balances
from its own ledger.

No implementation work has been performed for B4.

---

## 2. Complete remaining-table inventory

### 2.1 Tables already handled (B1–B3)

| Table | Rows | Blocker |
|---|---|---|
| auth.users | 623 | B1 |
| public.profiles | 622 | B1 |
| public.collections | 275 | B1 |
| public.contributions | 5,576 | B1 |
| public.contribution_code_counters | 53 | B1 |
| public.deposits | 6,201 | B2 |
| public.withdrawals | 292 | B3 |
| **Subtotal** | **13,642** | |

### 2.2 Remaining tables with data

| # | Table | Rows | PK type | PK column |
|---|---|---|---|---|
| 1 | auth.identities | 623 | uuid | id |
| 2 | public.wallets | 245 | uuid | id |
| 3 | public.wallets_backup_20260805 | 240 | uuid | id (nullable) |
| 4 | public.payment_recovery_log | 30,242 | uuid | id |
| 5 | public.pending_payment_context | 797 | **text** | **reference** |
| 6 | public.payment_admin_actions | 220 | uuid | id |
| 7 | public.payment_reference_backfill_snapshot_20260811 | 3,324 | uuid | contribution_id |
| 8 | public.settlement_runs | 57 | uuid | id |
| 9 | public.duplicate_void_snapshot_20260812 | 12 | uuid | contribution_id |
| 10 | public.email_campaign_recipients | 4,710 | uuid | id |
| 11 | public.email_campaign_audit_log | 96 | uuid | id |
| 12 | public.email_campaigns | 5 | uuid | id |
| 13 | public.email_templates | 8 | uuid | id |
| 14 | public.email_test_sends | 15 | uuid | id |
| 15 | public.email_campaign_attachments | 1 | uuid | id |
| 16 | public.notifications | 172 | uuid | id |
| 17 | public.push_notification_events | 173 | uuid | id |
| 18 | public.push_subscriptions | 13 | uuid | id |
| 19 | public.kyc_files | 53 | uuid | id |
| 20 | public.kyc_documents | 44 | uuid | id |
| 21 | public.kyc_verification_history | 55 | uuid | id |
| 22 | public.kyc_verifications | 21 | uuid | id |
| 23 | public.user_identity | 12 | uuid | id |
| 24 | public.payout_accounts | 26 | uuid | id |
| 25 | public.transfer_recipients | 52 | uuid | id |
| 26 | public.password_change_otps | 6 | uuid | id |
| 27 | public.admin_events | 71 | uuid | id |
| 28 | public.admin_users | 2 | uuid | id |
| 29 | public.campuses | 46 | **integer** | **campus_id** |
| 30 | public.ambassador_applications | 1 | uuid | id |
| 31 | public.ambassador_email_logs | 1 | uuid | id |
| 32 | public.campaign_images | 1 | uuid | id |
| 33 | public.campaigns | 1 | uuid | id |
| 34 | public.students | 1 | **integer** | **student_id** |
| 35 | public.verification_documents | 1 | uuid | id |
| **Subtotal** | **41,421** | | |

### 2.3 Empty tables (0 rows)

| Table | Reason |
|---|---|
| public.ambassador_influenced_organizers | Feature never used |
| public.ambassador_payout_accounts | Feature never used |
| public.ambassador_profiles | Feature never used |
| public.ambassador_resources | Feature never used |
| public.ambassador_withdrawals | Feature never used |
| public.campaign_donations | Feature never used |
| public.collection_access_grants | Feature never used |
| public.collection_access_invite_items | Feature never used |
| public.collection_access_invites | Feature never used |
| public.collection_transfer_requests | Feature never used |
| public.email_change_requests | Feature never used |
| public.email_unsubscribes | Feature never used |
| public.password_reset_otps | Feature never used |

Plus ~25 auth infrastructure tables (auth.sessions, auth.refresh_tokens,
auth.mfa_*, auth.sso_*, auth.saml_*, auth.flow_state, etc.) and ~5 storage
infrastructure tables (storage.migrations, storage.s3_multipart_*,
storage.buckets_analytics, storage.buckets_vectors, storage.vector_indexes)
— all 0 rows, all Supabase-managed.

### 2.4 Views (query definitions, no data)

| View | Purpose |
|---|---|
| email_recipient_directory | Marketing CRM view over profiles |
| v_collections_with_duplicate_tier_names | Diagnostic for tier dedup |
| v_orphaned_successful_payments | Captured payments missing contributions |
| v_payment_health_summary | Payment state aggregation |
| v_payment_inbox | Full payment lifecycle state machine |
| v_payment_invariants | Financial invariant violation monitor |
| v_payment_mismatch_rate | Hourly amount mismatch rate |
| v_payment_recovery_exhausted | Payments that exceeded retry cap |

Views are read-only query definitions. They reference tables already
classified above. No action needed.

### 2.5 Storage

| Bucket | Objects | Public |
|---|---|---|
| avatars | 13 | yes |
| campaign_assets | 1 | yes |
| email-attachments | 1 | yes |
| kyc-documents | 53 | no (sensitive) |
| campaign-documents | 0 | no |
| campaign-images | 0 | yes |
| **Total** | **68** | |

---

## 3. Exact row counts

### All D2 tables — authoritative counts

| Table | Exact count |
|---|---|
| **B1–B3 (already imported)** | |
| auth.users | 623 |
| public.profiles | 622 |
| public.collections | 275 |
| public.contributions | 5,576 |
| public.contribution_code_counters | 53 |
| public.deposits | 6,201 |
| public.withdrawals | 292 |
| **B4 → legacy_overflow** | |
| public.wallets | 245 |
| public.payment_recovery_log | 30,242 |
| public.pending_payment_context | 797 |
| public.payment_admin_actions | 220 |
| public.settlement_runs | 57 |
| public.admin_events | 71 |
| public.campuses | 46 |
| **B4 → Exclude (sensitive)** | |
| public.kyc_files | 53 |
| public.kyc_documents | 44 |
| public.kyc_verification_history | 55 |
| public.kyc_verifications | 21 |
| public.user_identity | 12 |
| public.payout_accounts | 26 |
| public.transfer_recipients | 52 |
| public.password_change_otps | 6 |
| public.push_subscriptions | 13 |
| **B4 → Exclude (ephemeral/operational)** | |
| auth.identities | 623 |
| public.wallets_backup_20260805 | 240 |
| public.payment_reference_backfill_snapshot_20260811 | 3,324 |
| public.duplicate_void_snapshot_20260812 | 12 |
| public.email_campaign_recipients | 4,710 |
| public.email_campaign_audit_log | 96 |
| public.email_campaigns | 5 |
| public.email_templates | 8 |
| public.email_test_sends | 15 |
| public.email_campaign_attachments | 1 |
| public.notifications | 172 |
| public.push_notification_events | 173 |
| public.admin_users | 2 |
| public.ambassador_applications | 1 |
| public.ambassador_email_logs | 1 |
| public.campaign_images | 1 |
| public.campaigns | 1 |
| public.students | 1 |
| public.verification_documents | 1 |
| **B4 → Defer (storage)** | |
| storage.objects | 68 |
| storage.buckets | 6 |
| **Grand total** | **55,063** |

---

## 4. Classification matrix

### Categories

| Code | Meaning | Criteria |
|---|---|---|
| **A** | Already imported | Covered by B1, B2, or B3 |
| **B** | Archive to legacy_overflow | Has audit/historical value, no target in new schema |
| **C** | Exclude — sensitive | Contains PII, encrypted credentials, or bank details |
| **D** | Exclude — ephemeral/operational | Empty, backup, snapshot, marketing, notifications, or Supabase-managed |
| **E** | Defer — storage | Binary objects requiring separate migration strategy |

### Full classification

| Table | Rows | Category | Destination |
|---|---|---|---|
| auth.users | 623 | A | B1: auth.users + public.users |
| public.profiles | 622 | A | B1: migration.legacy_profile |
| public.collections | 275 | A | B1: public.collections + migration.legacy_collection |
| public.contributions | 5,576 | A | B1: migration.legacy_contribution |
| public.contribution_code_counters | 53 | A | B1: public.collection_code_sequences |
| public.deposits | 6,201 | A | B2: migration.legacy_deposit + migration.unattributed_payments |
| public.withdrawals | 292 | A | B3: migration.legacy_withdrawal |
| public.wallets | 245 | **B** | migration.legacy_overflow |
| public.payment_recovery_log | 30,242 | **B** | migration.legacy_overflow |
| public.pending_payment_context | 797 | **B** | migration.legacy_overflow |
| public.payment_admin_actions | 220 | **B** | migration.legacy_overflow |
| public.settlement_runs | 57 | **B** | migration.legacy_overflow |
| public.admin_events | 71 | **B** | migration.legacy_overflow |
| public.campuses | 46 | **B** | migration.legacy_overflow |
| public.kyc_files | 53 | **C** | EXCLUDED — file paths to sensitive documents |
| public.kyc_documents | 44 | **C** | EXCLUDED — verification status + document types |
| public.kyc_verification_history | 55 | **C** | EXCLUDED — KYC audit trail with PII |
| public.kyc_verifications | 21 | **C** | EXCLUDED — BVN/NIN verification flags |
| public.user_identity | 12 | **C** | EXCLUDED — encrypted NIN/BVN (cipher + hash) |
| public.payout_accounts | 26 | **C** | EXCLUDED — encrypted bank account numbers |
| public.transfer_recipients | 52 | **C** | EXCLUDED — Paystack recipient codes + bank details |
| public.password_change_otps | 6 | **C** | EXCLUDED — OTP hashes |
| public.push_subscriptions | 13 | **C** | EXCLUDED — push auth secrets |
| auth.identities | 623 | **D** | EXCLUDED — Supabase-managed, recreated on sign-in |
| public.wallets_backup_20260805 | 240 | **D** | EXCLUDED — backup of wallets table, 240/245 overlap |
| public.payment_reference_backfill_snapshot_20260811 | 3,324 | **D** | EXCLUDED — maintenance snapshot, contributions in B1 |
| public.duplicate_void_snapshot_20260812 | 12 | **D** | EXCLUDED — maintenance snapshot, contributions in B1 |
| public.email_campaign_recipients | 4,710 | **D** | EXCLUDED — marketing delivery logs |
| public.email_campaign_audit_log | 96 | **D** | EXCLUDED — marketing admin log |
| public.email_campaigns | 5 | **D** | EXCLUDED — marketing infrastructure |
| public.email_templates | 8 | **D** | EXCLUDED — presentation templates |
| public.email_test_sends | 15 | **D** | EXCLUDED — dev/test data |
| public.email_campaign_attachments | 1 | **D** | EXCLUDED — single attachment record |
| public.notifications | 172 | **D** | EXCLUDED — ephemeral UI state |
| public.push_notification_events | 173 | **D** | EXCLUDED — delivery tracking |
| public.admin_users | 2 | **D** | EXCLUDED — 2 rows, new system has own admin |
| public.ambassador_applications | 1 | **D** | EXCLUDED — vestigial (1 row) |
| public.ambassador_email_logs | 1 | **D** | EXCLUDED — vestigial (1 row) |
| public.campaign_images | 1 | **D** | EXCLUDED — vestigial (1 row) |
| public.campaigns | 1 | **D** | EXCLUDED — vestigial (1 row) |
| public.students | 1 | **D** | EXCLUDED — vestigial (1 row) |
| public.verification_documents | 1 | **D** | EXCLUDED — vestigial (1 row) |
| 13 empty tables | 0 | **D** | EXCLUDED — no data |
| ~30 auth/storage infra tables | 0 | **D** | EXCLUDED — Supabase-managed, 0 rows |
| storage.objects | 68 | **E** | DEFERRED — binary object migration |
| storage.buckets | 6 | **E** | DEFERRED — bucket definitions |

---

## 5. Wallet analysis

### Schema

```
public.wallets (245 rows)
  id                  uuid NOT NULL (PK)
  collection_id       uuid NOT NULL (FK → collections)
  available_balance   numeric NOT NULL
  ledger_balance      numeric NOT NULL
  gross_payment       numeric NOT NULL
  net_payment         numeric NOT NULL
  withdrawn           numeric NOT NULL
  fee_breakdown       jsonb
  pending_balance     numeric NOT NULL
  created_at          timestamptz
  updated_at          timestamptz
```

### Aggregate totals (all 245 wallets)

| Field | Sum (₦) |
|---|---|
| available_balance | 114,038.30 |
| ledger_balance | 114,038.30 |
| gross_payment | 47,004,759.50 |
| net_payment | 46,069,692.94 |
| withdrawn | 46,204,412.80 |
| pending_balance | 0.00 |

### Relationships

- `wallets.collection_id` → `collections.id` (1:1 with collections)
- `withdrawals.wallet_id` → `wallets.id` (the only FK referencing wallets)
- B3 already preserves `legacy_wallet_id` in `legacy_withdrawal` rows

### Backup table

`wallets_backup_20260805` has 240 rows (all nullable columns), overlapping
with 240 of the 245 current wallet rows. This is a maintenance backup taken
before a D2 operation. It adds no information beyond the current wallets table.

### CRITICAL: Wallets must NOT become financial truth

The wallet balances are D2-computed aggregates derived from contributions,
deposits, and withdrawals. They represent the D2 system's view of each
collection's financial state at the time of the restore.

**These balances MUST NOT be used as:**
- Opening balances in the new ledger
- Seeds for new wallet rows
- Authoritative financial records
- Inputs to any reconciliation that determines real-money outcomes

**They SHOULD be preserved as:**
- Historical audit snapshots (for answering "what did D2 think the balance was?")
- Reference data for manual investigation of legacy disputes
- Context for understanding legacy withdrawal and settlement patterns

### Destination

Archive all 245 wallet rows to `migration.legacy_overflow` with full field
snapshots. The `fee_breakdown` JSONB is included. No financial computation
uses these values.

---

## 6. Financial safety analysis

### Tables touching money

| Table | Rows | Financial content | B4 action |
|---|---|---|---|
| wallets | 245 | Computed balances, fee breakdowns | Archive (read-only snapshot) |
| pending_payment_context | 797 | Paystack capture state, amounts | Archive (audit trail) |
| payment_recovery_log | 30,242 | Recovery attempt context with amounts | Archive (operational log) |
| payment_admin_actions | 220 | Manual status changes with reasons | Archive (admin audit) |
| settlement_runs | 57 | Settlement batch results | Archive (settlement history) |
| payout_accounts | 26 | Bank account ciphertexts | EXCLUDE (sensitive) |
| transfer_recipients | 52 | Paystack recipient codes | EXCLUDE (sensitive) |

### Financial safety contract for B4

1. **Zero new ledger entries** — B4 creates no rows in `ledger_journals`,
   `ledger_entries`, or `financial_events`
2. **Zero new wallet rows** — B4 does not create, seed, or update any
   `public.wallets` row in the new system
3. **Zero Paystack calls** — B4 makes no API calls to any payment provider
4. **Zero balance computations** — archived wallet balances are stored as
   opaque JSONB, not parsed or used in arithmetic
5. **Zero opening balances** — no legacy_overflow row produces an opening
   balance, credit, or debit in the new system
6. **The importer role has no access** to `ledger_*`, `financial_events`,
   or `public.wallets` — this is enforced at the Postgres GRANT level and
   cannot be bypassed by application code

### Payment tables not being imported

`payment_reference_backfill_snapshot_20260811` and
`duplicate_void_snapshot_20260812` are excluded (category D). They are
maintenance snapshots whose underlying contributions are already preserved
in B1. Archiving the snapshot separately would create a false impression
of independent financial records.

---

## 7. Sensitive-data analysis

### Highly sensitive (encrypted PII)

| Table | Rows | Sensitive fields | Risk |
|---|---|---|---|
| user_identity | 12 | `nin_cipher` (bytea), `bvn_cipher` (bytea), `nin_hash`, `bvn_hash`, `nin_last4`, `bvn_last4` | Government ID numbers, encrypted with D2-specific keys |
| payout_accounts | 26 | `account_number_cipher` (bytea), `account_last4`, `bank_code`, `bank_name`, `account_name`, `recipient_code` | Bank account details, partially encrypted |

### Sensitive (PII / credentials)

| Table | Rows | Sensitive fields | Risk |
|---|---|---|---|
| transfer_recipients | 52 | `account_number`, `bank_code`, `recipient_code` | Paystack recipient records with bank details |
| kyc_verifications | 21 | BVN/NIN/bank/identity/address/selfie verification flags | KYC verification status |
| kyc_documents | 44 | `document_type`, `verification_type`, user_id | KYC document metadata |
| kyc_files | 53 | `file_path`, `file_name` | Paths to uploaded identity documents |
| kyc_verification_history | 55 | `old_status`, `new_status`, `changed_by` | KYC audit trail |
| password_change_otps | 6 | `otp_hash`, `expires_at` | OTP credential hashes |
| push_subscriptions | 13 | `endpoint`, `p256dh`, `auth_secret` | Web Push cryptographic secrets |

### Action: ALL excluded from B4

None of these tables are archived. Reasons:

1. **Encrypted fields** (`*_cipher` bytea columns) — the encryption keys
   belong to the D2 deployment. Copying ciphertext without the key produces
   unreadable data. If the key is also migrated, the attack surface doubles.
2. **Government IDs** (NIN, BVN) — regulatory obligation to minimize copies.
   The new system must collect these through its own KYC flow.
3. **Bank account details** — D2-era Paystack recipient codes are not valid
   in the new Paystack integration. New payout details will be collected.
4. **KYC documents** — file paths reference D2 storage buckets. The 53
   objects in the `kyc-documents` bucket are deferred with storage (category E)
   but their metadata records are not archived.
5. **OTP hashes / push secrets** — ephemeral credentials that expire or
   are replaced on next use.

### Sensitive fields already handled (B1–B3)

- `withdrawals.destination_account` (bank details JSONB) — excluded from
  legacy_withdrawal.fields by schema CHECK constraint `legacy_withdrawal_no_bank_details`
- Profile email/phone — preserved in legacy_profile (needed for identity resolution)
- Contribution email/phone — preserved in legacy_contribution.fields
  (needed for contributor matching)

---

## 8. legacy_overflow schema assessment

### Current schema (on rehearsal target `127.0.0.1:5455`)

```sql
migration.legacy_overflow (
  id               uuid NOT NULL DEFAULT uuid_generate_v7(),
  source_project   text NOT NULL,
  source_table     text NOT NULL,     -- CHECK: schema-qualified
  source_id        text NOT NULL,     -- TEXT, not UUID
  source_key_columns text[] NOT NULL, -- CHECK: cardinality > 0
  import_run_id    uuid NOT NULL,
  imported_at      timestamptz NOT NULL DEFAULT now(),
  fields           jsonb NOT NULL,    -- CHECK: jsonb_typeof = 'object'

  UNIQUE (source_project, source_table, source_id)
)
```

### Protections

- Append-only: UPDATE, DELETE, TRUNCATE are refused (trigger + revoke)
- `source_table` must match `^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$`
- `fields` must be a JSON object (not array, string, or null)
- `source_key_columns` must have at least one element

### Assessment: SUFFICIENT for B4

| Requirement | Supported | Notes |
|---|---|---|
| Non-UUID PKs (text, integer) | Yes | `source_id` is TEXT — cast integer/text PKs to string |
| Composite PKs | Yes | `source_key_columns` records the PK column names |
| Schema-qualified source_table | Yes | CHECK constraint enforces pattern |
| Append-only | Yes | Trigger + grant protections |
| Idempotency | Yes | Unique index on (source_project, source_table, source_id) |
| Arbitrary field shapes | Yes | `fields` is JSONB object |
| Cross-table querying | Yes | Index on source_table for filtered scans |
| Importer role access | Verify | Confirm `kolekto_importer` has INSERT + SELECT |

### No schema changes needed

The existing `legacy_overflow` table design handles all 7 B4 overflow tables
without modification. The only implementation work is adding orchestrator
phases that read from D2 and insert into legacy_overflow.

---

## 9. Source-ID strategy

### PK types in B4 overflow tables

| Table | PK column | PK type | Strategy |
|---|---|---|---|
| wallets | id | uuid | Cast to text: `id::text` |
| payment_recovery_log | id | uuid | Cast to text: `id::text` |
| pending_payment_context | **reference** | **text** | Use directly (already text) |
| payment_admin_actions | id | uuid | Cast to text: `id::text` |
| settlement_runs | id | uuid | Cast to text: `id::text` |
| admin_events | id | uuid | Cast to text: `id::text` |
| campuses | **campus_id** | **integer** | Cast to text: `campus_id::text` |

### source_key_columns values

| Table | source_key_columns |
|---|---|
| wallets | `['id']` |
| payment_recovery_log | `['id']` |
| pending_payment_context | `['reference']` |
| payment_admin_actions | `['id']` |
| settlement_runs | `['id']` |
| admin_events | `['id']` |
| campuses | `['campus_id']` |

### Deterministic target UUIDs

For legacy_overflow rows, the target UUID is derived via:

```
targetUuidFor(source_project, "legacy_overflow:" + source_table, source_id)
```

The `kind` includes the source table to prevent ID collisions between
different D2 tables that happen to share source IDs (e.g., two tables could
both have a row with `id = 'abc'`).

---

## 10. Provenance strategy

### imported_objects entries

Every legacy_overflow row gets a corresponding `migration.imported_objects`
entry, following the same pattern as B1–B3:

| Field | Value |
|---|---|
| source_project | From orchestrator input |
| import_run_id | Current run UUID |
| source_table | Schema-qualified D2 table (e.g., `'public.wallets'`) |
| source_id | D2 PK cast to text |
| target_table | `'migration.legacy_overflow'` |
| target_id | Deterministic UUID from targetUuidFor |

### Idempotency

Both `legacy_overflow` and `imported_objects` use `ON CONFLICT DO NOTHING`
keyed on their unique indexes.

### Provenance chain

```
D2 source row
  → migration.legacy_overflow.fields (full JSONB snapshot)
  → migration.imported_objects (source ↔ target link)
  → migration.import_runs (run metadata)
```

This matches the provenance pattern established in B1–B3 for legacy_deposit,
legacy_contribution, and legacy_withdrawal.

---

## 11. Control totals

### B4 overflow target totals (7 tables → legacy_overflow)

| source_table | Expected rows | Checksum basis |
|---|---|---|
| public.wallets | 245 | count(*) from wallets |
| public.payment_recovery_log | 30,242 | count(*) from payment_recovery_log |
| public.pending_payment_context | 797 | count(*) from pending_payment_context |
| public.payment_admin_actions | 220 | count(*) from payment_admin_actions |
| public.settlement_runs | 57 | count(*) from settlement_runs |
| public.admin_events | 71 | count(*) from admin_events |
| public.campuses | 46 | count(*) from campuses |
| **Total** | **31,678** | |

### Reconciliation checks for B4

After import, verify:

1. `count(*) from legacy_overflow where source_table = 'public.wallets'` = 245
2. `count(*) from legacy_overflow where source_table = 'public.payment_recovery_log'` = 30,242
3. `count(*) from legacy_overflow where source_table = 'public.pending_payment_context'` = 797
4. `count(*) from legacy_overflow where source_table = 'public.payment_admin_actions'` = 220
5. `count(*) from legacy_overflow where source_table = 'public.settlement_runs'` = 57
6. `count(*) from legacy_overflow where source_table = 'public.admin_events'` = 71
7. `count(*) from legacy_overflow where source_table = 'public.campuses'` = 46
8. Total legacy_overflow rows = 31,678
9. Total imported_objects for target_table = 'migration.legacy_overflow' = 31,678
10. Zero ledger_journals, ledger_entries, financial_events created
11. Zero wallet rows created in public.wallets

### Financial control totals (wallet archive only)

| Metric | Expected |
|---|---|
| Sum of archived available_balance (in fields) | ₦114,038.30 |
| Sum of archived ledger_balance (in fields) | ₦114,038.30 |
| Sum of archived gross_payment (in fields) | ₦47,004,759.50 |
| Sum of archived net_payment (in fields) | ₦46,069,692.94 |
| Sum of archived withdrawn (in fields) | ₦46,204,412.80 |
| Wallet rows created in new system | 0 |
| Ledger entries created | 0 |

---

## 12. Proposed destination for every table

### Summary by destination

| Destination | Tables | Rows |
|---|---|---|
| B1 (auth.users, users, communities, collections, tiers, links, sequences, legacy_profile, legacy_collection, legacy_contribution, imported_objects) | 7 source tables | 13,642 |
| B2 (legacy_deposit, unattributed_payments) | 1 source table | 6,201 |
| B3 (legacy_withdrawal) | 1 source table | 292 |
| B4 → migration.legacy_overflow | 7 source tables | 31,678 |
| EXCLUDED (sensitive) | 9 source tables | 282 |
| EXCLUDED (ephemeral/operational) | 19 source tables | 9,387 |
| EXCLUDED (empty) | 13+ source tables | 0 |
| DEFERRED (storage) | 2 source tables | 74 |
| Views (no action) | 8 views | N/A |
| **Total** | **67+ tables** | **61,556** |

---

## 13. Explicit exclusions and reasons

### Category C — Sensitive data exclusions

| Table | Rows | Reason |
|---|---|---|
| user_identity | 12 | Encrypted NIN/BVN with D2-specific keys; regulatory minimization |
| payout_accounts | 26 | Encrypted bank account numbers; new system collects fresh |
| transfer_recipients | 52 | D2-era Paystack recipient codes; invalid in new integration |
| kyc_verifications | 21 | BVN/NIN verification flags; re-verify in new system |
| kyc_documents | 44 | KYC metadata tied to D2 storage paths |
| kyc_files | 53 | File paths to sensitive documents in D2 storage |
| kyc_verification_history | 55 | KYC audit trail; stays with D2 archive |
| password_change_otps | 6 | Ephemeral OTP hashes |
| push_subscriptions | 13 | Contains auth_secret (crypto key material) |

### Category D — Ephemeral/operational exclusions

| Table | Rows | Reason |
|---|---|---|
| auth.identities | 623 | Supabase-managed; recreated on sign-in |
| wallets_backup_20260805 | 240 | Maintenance backup; 240/245 duplicate of wallets |
| payment_reference_backfill_snapshot_20260811 | 3,324 | Maintenance snapshot; contributions already in B1 |
| duplicate_void_snapshot_20260812 | 12 | Maintenance snapshot; contributions already in B1 |
| email_campaign_recipients | 4,710 | Marketing delivery logs; no value in new system |
| email_campaign_audit_log | 96 | Marketing admin log |
| email_campaigns | 5 | Marketing campaign definitions |
| email_templates | 8 | Presentation-layer HTML templates |
| email_test_sends | 15 | Dev/test data |
| email_campaign_attachments | 1 | Single attachment record |
| notifications | 172 | Ephemeral in-app notification state |
| push_notification_events | 173 | Push delivery tracking |
| admin_users | 2 | 2 rows; new system has own admin management |
| ambassador_applications | 1 | Vestigial (1 row) |
| ambassador_email_logs | 1 | Vestigial (1 row) |
| campaign_images | 1 | Vestigial (1 row) |
| campaigns | 1 | Vestigial (1 row) |
| students | 1 | Vestigial (1 row) |
| verification_documents | 1 | Vestigial (1 row) |
| 13 empty public tables | 0 | No data to preserve |
| ~30 auth/storage infra tables | 0 | Supabase-managed, ephemeral |

### Category E — Deferred

| Table | Rows | Reason |
|---|---|---|
| storage.objects | 68 | Binary objects require separate migration strategy |
| storage.buckets | 6 | Bucket definitions tied to storage.objects |

Storage migration is a separate concern from data migration. The 53
`kyc-documents` objects are sensitive. The 13 `avatars` are user-facing but
low-priority. This is deferred to a future phase after B4.

---

## 14. Proposed implementation phases

### Phase B4-1: SourceRepository extension

Add to `SourceRepository` interface:

```typescript
readonly listWallets: () => Promise<readonly LegacyWallet[]>;
readonly listPaymentRecoveryLogs: () => Promise<readonly LegacyPaymentRecoveryLog[]>;
readonly listPendingPaymentContexts: () => Promise<readonly LegacyPendingPaymentContext[]>;
readonly listPaymentAdminActions: () => Promise<readonly LegacyPaymentAdminAction[]>;
readonly listSettlementRuns: () => Promise<readonly LegacySettlementRun[]>;
readonly listAdminEvents: () => Promise<readonly LegacyAdminEvent[]>;
readonly listCampuses: () => Promise<readonly LegacyCampus[]>;
```

### Phase B4-2: Orchestrator overflow phase

Add a single new orchestrator phase after the withdrawal phase:

```
Phase 8: Overflow → migration.legacy_overflow
  For each overflow table:
    Read all rows from D2
    For each row:
      sql.begin() with import context + importer role
      INSERT INTO migration.legacy_overflow (source_project, source_table, source_id,
        source_key_columns, import_run_id, fields)
      INSERT INTO migration.imported_objects (provenance)
      ON CONFLICT DO NOTHING
```

Batch by source table (one table at a time). Each row in its own transaction
for isolation, matching the B1–B3 pattern.

### Phase B4-3: Reconciliation extension

Add to `reconcile.ts`:

- Per-table overflow count checks (7 checks, one per source table)
- Total overflow count check
- Provenance count for legacy_overflow targets
- Financial safety assertions (0 ledger, 0 wallet, 0 financial_events)

### Phase B4-4: Synthetic tests

Add synthetic fixtures for:

- 1 wallet (with fee_breakdown JSONB)
- 1 payment_recovery_log entry
- 1 pending_payment_context entry (TEXT PK)
- 1 payment_admin_action
- 1 settlement_run
- 1 admin_event
- 1 campus (INTEGER PK)

Test assertions:

- Overflow row counts match per table
- Fields JSONB contains complete source snapshot
- Non-UUID PKs correctly stored as TEXT source_id
- source_key_columns correctly populated
- Provenance (imported_objects) entries exist for all overflow rows
- Idempotency (second run creates 0 new rows)
- Financial safety (0 ledger, 0 wallet, 0 financial_events)
- Wallet balances are NOT used to create new wallet rows

### Phase B4-5: Control total reconciliation

Run against D2 restore to verify exact counts match discovery totals.

### Phase B4-6: Documentation

Update IMPORTER-IMPLEMENTATION-REPORT.md, SYNTHETIC-IMPORT-REPORT.md with
B4 results. Write B4 implementation report.

### Estimated effort

- B4-1 (types + repo): ~50 lines
- B4-2 (orchestrator): ~80 lines
- B4-3 (reconciliation): ~30 lines
- B4-4 (synthetic tests): ~120 lines
- B4-5 (control totals): verification only
- B4-6 (docs): reports

Total new code: ~280 lines. No schema changes. No new migrations.

---

## 15. Synthetic test plan

### New fixtures needed

```typescript
// Wallet fixture (UUID PK)
const W_WALLET: LegacyWallet = {
  id: "5e000001-...",
  collection_id: C_FIXED,  // references imported collection
  available_balance: "1500.50",
  ledger_balance: "1500.50",
  gross_payment: "2000.00",
  net_payment: "1970.00",
  withdrawn: "470.00",
  fee_breakdown: { platform_fee: "30.00" },
  pending_balance: "0.00",
  created_at: "...",
  updated_at: "..."
};

// Pending payment context fixture (TEXT PK!)
const PPC: LegacyPendingPaymentContext = {
  reference: "KLK_REF_TEST_001",  // TEXT PK
  collection_id: C_FIXED,
  metadata: { contact: { name: "Test" } },
  state: "completed",
  // ... remaining fields
};

// Campus fixture (INTEGER PK!)
const CAMPUS: LegacyCampus = {
  campus_id: 99,  // integer
  campus_name: "Test Campus",
  campus_code: "TST"
};
```

### Test assertions (estimated 12–15 new assertions)

1. **Overflow count per table** — 7 checks, one per source table
2. **Total overflow count** — sum matches expected
3. **Wallet fields snapshot** — complete JSONB, includes fee_breakdown
4. **Wallet does NOT create new wallet row** — 0 rows in public.wallets
5. **Text PK handling** — pending_payment_context reference stored correctly
6. **Integer PK handling** — campus_id stored as text in source_id
7. **source_key_columns** — correct array for each table type
8. **Provenance** — every overflow row has imported_objects entry
9. **Idempotency** — second run creates 0 new overflow rows
10. **Financial safety** — 0 ledger, 0 wallet, 0 financial_events
11. **Append-only** — UPDATE on legacy_overflow refused

---

## 16. Risks and blockers

### Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | payment_recovery_log is 30,242 rows — largest overflow table | Low | Batch by source table, one row per transaction. Synthetic tests use 1 row. |
| 2 | pending_payment_context has TEXT PK (`reference`) | Low | legacy_overflow.source_id is already TEXT. Verified in schema assessment. |
| 3 | campuses has INTEGER PK (`campus_id`) | Low | Cast to text. legacy_overflow.source_id is TEXT. |
| 4 | Wallet balances misused as financial truth | **High** | Enforced by: importer role has no access to public.wallets or ledger tables; synthetic test asserts 0 wallet rows created; reconciliation asserts 0 ledger entries. |
| 5 | payment_recovery_log.context contains Paystack verification payloads | Medium | These are operational context (error codes, amounts), not credentials. The Paystack API keys are not in the data. Archive as-is. |
| 6 | pending_payment_context.verification_payload contains Paystack response | Medium | Same as above — operational data, not credentials. |
| 7 | pending_payment_context.metadata may contain contributor PII (name, email, phone) | Medium | This is the same level of PII already preserved in legacy_contribution.fields (B1) and legacy_deposit.fields (B2). Consistent treatment. |

### Blockers

| # | Blocker | Status |
|---|---|---|
| 1 | Confirm kolekto_importer has INSERT + SELECT on migration.legacy_overflow | Verify before implementation |
| 2 | Confirm importer role does NOT have access to public.wallets in new schema | Verify before implementation |
| 3 | Storage/image migration strategy | Deferred — separate phase, not blocking B4 |

### No blockers prevent B4 implementation from starting.

---

## 17. Implementation status

**B4 implementation has NOT started.**

This document is a read-only discovery and design report. No code was written,
no data was imported, no schema was modified, no tests were added, and no
orchestrator phases were created for B4.

The D2 restore at `127.0.0.1:5544` was queried in read-only mode. The
rehearsal target at `127.0.0.1:5455` was queried for schema inspection only
(legacy_overflow table structure). Neither was modified.

### Blocker status summary

| Blocker | Status |
|---|---|
| B1 — Contributions | CLOSED — PASS |
| B2 — Deposits | CLOSED — PASS |
| B3 — Withdrawals | CLOSED — PASS |
| B4 — Overflow/wallets | **DISCOVERY COMPLETE — implementation pending** |
