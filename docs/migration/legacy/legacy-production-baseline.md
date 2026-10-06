# Legacy production baseline

**Project:** `busfgcmbndleljklrcbd` — "kolekto prod"
**Region:** eu-central-1 · **PostgreSQL:** 15.8.1.094 · **Status:** ACTIVE_HEALTHY
**Created:** 2025-06-02 · **Organization:** `Kolekto Org` (`wzkhbvbimazkabmdbawa`)
**Captured:** 2026-09-26 · **Method:** read-only SQL over account-level MCP access
**Classification:** **LEGACY PRODUCTION — LIVE, RECEIVING REAL TRANSACTIONS**

> **Nothing in this project was modified.** No DDL, no DML, no migration, no
> policy change, no grant change, no auth configuration change. Every statement
> issued was a `SELECT` against catalogs or aggregates.

**Companions:** [control totals](legacy-control-totals.md) ·
[financial inventory](legacy-financial-inventory.md) ·
[identity inventory](legacy-identity-inventory.md) ·
[collection model](legacy-collection-model.md) ·
[withdrawal model](legacy-withdrawal-model.md) ·
[mapping](legacy-to-new-mapping.md) ·
[exceptions](legacy-migration-exceptions.md) ·
[data-loss policy](migration-data-loss-policy.md) ·
[runbook](migration-runbook.md) · [environment](legacy-environment.md)

---

## 1. The five things that matter most

**1. The production schema is not reproducible from the legacy migration files.**
`supabase_migrations.schema_migrations` holds **39 versions, earliest
`20260514201017`** — May 2026. But the earliest profile is **2025-06-02**, a year
earlier. The schema therefore predates its own migration tracking, so the only
reliable description of legacy production is the live database itself. **This
baseline is that description.** Any migration built from the legacy repository's
SQL files alone would be built against a schema that does not exist.

**2. There is no community.** Legacy `collections.user_id` points straight at an
auth user. The new architecture's root aggregate is `communities`, and
`collections.community_id` is `not null`. Every one of the 275 legacy collections
therefore needs a community to exist before it can land. This is the single
largest structural transformation in the migration and it is not a detail.

**3. `anon` holds TRUNCATE on ten tables in live production.** RLS blocks its
INSERT/UPDATE/DELETE, but **RLS does not apply to TRUNCATE.** Two of the ten are
financial: `settlement_runs` and `wallets_backup_20260805`. See §6.

**4. Money is exactly convertible.** Across all 11 monetary columns, no value
exceeds 2 decimal places and none is negative. `round(v*100)` to integer kobo is
lossless, and no rounding policy decision is needed.

**5. Production is mutating while you read this.** Two cron jobs are active: a
payment-recovery poll every 5 minutes and `settlement_recompute_wallets` daily at
04:00 UTC. This is a baseline, not the migration snapshot.

---

## 2. Database structure

| Schema | Tables | Views | Sequences |
|---|---|---|---|
| `public` | **53** | 8 | 2 |
| `auth` | 27 | 0 | 1 |
| `realtime` | 9 | 0 | 1 |
| `storage` | 8 | 0 | 0 |
| `cron` | 2 | 0 | 2 |
| `net` | 2 | 0 | 1 |
| `supabase_migrations` | 1 | 0 | 0 |
| `vault` | 1 | 1 | 0 |
| `extensions` | 0 | 4 | 0 |

**10 extensions**, including `pg_cron` and `pg_net` — the combination that lets
the database call an HTTP endpoint on a schedule (§5).

`public` has **2 enums, 0 domains, 9 triggers, 95 functions**. Note the absence of
domains: there is no `app.kobo` equivalent, which is why money is `numeric`.

Per-table row counts, primary keys and RLS status are in
[legacy-control-totals.md](legacy-control-totals.md) §1 and
[legacy-schema-inventory.md](legacy-schema-inventory.md).

---

## 3. Subsystems present in legacy and absent from the new architecture

This is the zero-data-loss surface. Grouped by what they are, with row counts.

| Subsystem | Tables | Rows | New-schema equivalent |
|---|---|---|---|
| **Ambassador programme** | 6 (`ambassador_applications`, `_email_logs`, `_influenced_organizers`, `_payout_accounts`, `_profiles`, `_withdrawals`) | 2 | **none** |
| **Campaigns** (parallel fundraising entity) | 3 (`campaigns`, `campaign_donations`, `campaign_images`) | 2 | **none** — distinct from `collections` |
| **Campus / student directory** | 2 (`campuses`, `students`) | 47 | **none** |
| **Email campaign engine** | 8 (`email_campaigns`, `_recipients`, `_attachments`, `_audit_log`, `email_templates`, `email_test_sends`, `email_unsubscribes`, `email_change_requests`) | 4,839 | **none** |
| **Push notifications** | 2 (`push_subscriptions`, `push_notification_events`) | 186 | **none** |
| **In-app notifications** | 1 (`notifications`) | 172 | designed, not built |
| **KYC / identity verification** | 5 (`kyc_verifications`, `_documents`, `_files`, `_verification_history`, `verification_documents`) | 174 | `verification_records` — designed, not built, and **shape conflict** (§4) |
| **Staff realm** | 2 (`admin_users`, `admin_events`) | 73 | `staff_users` — designed, not built |
| **OTP / password flows** | 2 (`password_change_otps`, `password_reset_otps`) | 6 | **none** — Supabase Auth handles this in the new system |
| **Collection sharing / transfer** | 4 (`collection_access_grants`, `_invites`, `_invite_items`, `collection_transfer_requests`) | 0 | partially `officer_terms` / `invite_links` |
| **Forensic snapshots** | 3 (`payment_reference_backfill_snapshot_20260811`, `duplicate_void_snapshot_20260812`, `wallets_backup_20260805`) | 3,576 | **none** — pure history |

**Every one of these needs an explicit destination.** None may be dropped on the
grounds that the new product does not have the feature. See
[migration-data-loss-policy.md](migration-data-loss-policy.md).

---

## 4. Programmability

**95 functions in `public`**, 20 SECURITY DEFINER.

### Money-touching functions

| Function | Definer | anon | writes | Role |
|---|---|---|---|---|
| `record_payment_capture` | **yes** | no | yes | capture-first write |
| `mark_payment_completed` | **yes** | no | yes | state transition |
| `mark_payment_needs_review` | **yes** | no | yes | parks money safely |
| `get_orphaned_payment_candidates` | yes | no | no | the ₦19.8m investigation |
| `get_historical_orphaned_payments_summary` | yes | authed | no | reporting |
| `get_overwithdrawn_collections_reconciliation` | yes | authed | no | reporting |
| `claim_payment_contributions` | no | **yes** | yes | atomic, idempotent claim |
| `request_withdrawal_atomic` | no | **yes** | yes | withdrawal request |
| `approve_withdrawal_atomic` | no | no | yes | withdrawal approval |
| `settlement_recompute_wallets` | no | **yes** | yes | **the nightly cache rebuild** |
| `settle_pending_balances` | no | no | yes | settlement |
| `process_deposit_settlements` | no | no | yes | settlement |
| `settlement_cutoff` | no | **yes** | no | the T+1 cutoff comparison |
| `genuine_net_payment` | no | no | no | drift diagnosis helper |
| `completed_withdrawn` | no | no | no | drift diagnosis helper |
| `next_contribution_code_number` | no | no | yes | code allocation |

**Zero functions are both SECURITY DEFINER and anon-executable.** The historical
CRITICAL finding — three definer functions driving the payment state machine,
callable with the publishable key — **is remediated.**

Four functions remain anon-executable *and* write data, but all are SECURITY
INVOKER, so their writes execute as `anon` and hit RLS. See §6 for what that does
and does not protect.

### Views — 8, all in `public`

`email_recipient_directory`, `v_collections_with_duplicate_tier_names`,
`v_orphaned_successful_payments`, `v_payment_health_summary`, `v_payment_inbox`,
`v_payment_invariants`, `v_payment_mismatch_rate`, `v_payment_recovery_exhausted`.

**All 8 are SECURITY DEFINER (they bypass RLS). None is granted to `anon`** — the
historical "seven definer views exposed to anon" finding is also remediated.

Worth noting for its own sake: the legacy team built
`v_collections_with_duplicate_tier_names` and `v_orphaned_successful_payments`.
They knew about both hazards this baseline re-measures.

---

## 5. Scheduled jobs — both active

| Job | Schedule | What it does |
|---|---|---|
| 5 | `*/5 * * * *` | `net.http_post` to the `scheduled-payment-recovery` Edge Function |
| 6 | `0 4 * * *` | `SELECT public.settlement_recompute_wallets('cron')` |

Job 5 explains `payment_recovery_log` at 30,242 rows — a poll every five minutes
for months. Job 6 is the nightly recompute of all 245 wallet rows that the new
architecture replaces with a ledger; it runs at 04:00 **UTC**, which is 05:00 WAT.

**Job 5's command contains a shared secret in plaintext.** Reported in §6 by type
and location only.

---

## 6. Security

### Posture that is correct

RLS is **enabled on all 53 public tables**. No definer function is anon-callable.
No definer view is anon-callable. `payout_accounts.account_number_cipher` and
`user_identity`'s NIN/BVN columns are encrypted at rest.

### S1 — `anon` holds TRUNCATE on ten tables in live production · **HIGH**

`anon` currently holds `INSERT`, `UPDATE`, `DELETE` **and `TRUNCATE`** on:

`admin_events`, `email_campaign_attachments`, `email_campaign_audit_log`,
`email_campaign_recipients`, `email_campaigns`, `email_templates`,
`email_test_sends`, `email_unsubscribes`, **`settlement_runs`**,
**`wallets_backup_20260805`**.

All ten have **zero RLS policies**, so RLS denies the INSERT/UPDATE/DELETE. But
**PostgreSQL does not apply RLS to TRUNCATE.** The grant is therefore directly
usable by anyone holding the publishable anon key, which ships in the JavaScript
of every page.

Exposure is **destruction, not exfiltration**: 56 settlement-run audit rows, 240
rows of wallet-balance forensic history, and the entire email subsystem including
4,710 recipient records. `wallets_backup_20260805` is financial forensic evidence
from the 2026-08-05 incident.

**Recommendation:** revoke `TRUNCATE` (and the other three) from `anon` on all
ten. **I did not do this** — it is a write to legacy production and outside a
read-only mandate. It is a one-statement change and should be scheduled
deliberately.

### S2 — `anon` holds SELECT on 49 of 53 tables · **MEDIUM**

Row visibility is RLS-mediated, and most tables have policies. But the breadth
means every new table is exposed by default unless someone remembers a policy.

### S3 — `authenticated` holds UPDATE on `collections` and `profiles` · **MEDIUM, likely intentional**

Also `campaigns`, `kyc_documents`, `kyc_verifications`. RLS-scoped, and consistent
with a legacy app that writes from the client. The new architecture forbids this
pattern (ADR 0011: writes go through `app.*` functions), so it does not carry over.

### S4 — RLS enabled but not FORCED on 50 of 53 tables · **LOW**

Only the three forensic snapshot tables have `FORCE`. Without it the table owner
bypasses RLS. The owner is a privileged role, so this is defence-in-depth rather
than an open door.

### S5 — bank account numbers are stored inconsistently · **MEDIUM**

`payout_accounts.account_number_cipher` is `bytea` (encrypted, with
`account_last4` for display). `transfer_recipients.account_number` is **plaintext
`text`**, 52 rows. Two tables holding the same class of data to two different
standards. The migration must not carry the plaintext form forward.

### S6 — secrets discovered · type and location only

Per the brief, no value is printed, here or in any artifact.

| # | Secret type | Location | Severity | Recommendation |
|---|---|---|---|---|
| 1 | Cron shared secret (`X-Cron-Secret`) | `cron.job` command, jobid 5, legacy production | **HIGH** | Rotate. It is readable by anyone who can select from `cron.job`, and it authenticates a payment-recovery endpoint. |
| 2 | Paystack **live** secret key | `kolekto-be-old/.env`, `.env.bak.pre-email-fix`, and 2 historical diffs in that repo's git history (commit `1f82604` added `prod.env`) | **HIGH** | Rotate, scheduled with a deploy. Carried over from the M8.1 audit; unchanged. |

Neither was copied into this repository. Re-verified this session: no Paystack key
value exists anywhere in the new repository's working tree or full git history.

### Sensitive data classes, for migration planning

| Table | Contains | Constraint on migration |
|---|---|---|
| `user_identity` | NIN and BVN ciphertext, hashes, last-4 | **National identity numbers.** Never export. The new `verification_records` design deliberately stores a provider reference and result, *not* raw ID data — so this is a **shape conflict** needing a legal ruling, not an engineering choice. |
| `payout_accounts` | encrypted account number, last-4, recipient code | Decryption key location unknown; must be established before migration |
| `transfer_recipients` | **plaintext** account numbers | Do not carry the plaintext form |
| `withdrawals.destination_account` | jsonb bank details | Likely contains account numbers; treat as sensitive |
| `profiles` | name, email, phone, address, DOB, signup IP | Standard PII |
| `contributions` | contributor name, email, phone | 3,353 distinct contributor emails |

---

## 7. What this baseline does not cover

- **Legacy test (`lpeeckqsltxohppheucz`) has not been inspected.** Phase 11
  requires stopping and asking first. Not done.
- **No raw row data was extracted.** Every figure is an aggregate. No dump exists
  and none was written to the repository.
- **`auth` internals beyond counts.** No password hash, token, or session was read.
- **Storage buckets and their objects** were not inventoried.
- **Edge Functions** were not read — `scheduled-payment-recovery` is referenced by
  cron but its source lives outside the database.
- **Decryption keys** for `user_identity` and `payout_accounts` were not located.
