# Legacy test baseline

**Project:** `lpeeckqsltxohppheucz` — "Kolekto test"
**Region:** eu-north-1 · **PostgreSQL:** **17.4.1.064** (engine 17, GA)
**Status:** ACTIVE_HEALTHY · **Created:** 2025-06-27
**Organization:** `Kolekto Org` (`wzkhbvbimazkabmdbawa`)
**Captured:** 2026-09-26 · **Method:** read-only SQL, project ref named explicitly on
every query, nothing linked
**Classification:** LEGACY TEST

> **Nothing in this project was modified.** No DDL, no DML, no migration, no policy,
> grant, auth, storage, function, cron or Paystack change. Every statement was a
> `SELECT` against catalogs or aggregates. No password, hash, session or token was
> read.

**Comparison against production:** [legacy-prod-vs-test.md](legacy-prod-vs-test.md)

---

## 1. The headline: test is not a smaller copy of production

Three findings make test structurally *different*, not merely *smaller*:

**1. Test contains a workspace/membership model that production does not have.**
`workspaces` (176), `workspace_members` (227), `workspace_invites` (9), and a
nullable `collections.workspace_id` that **93 of 95 collections populate**. This is a
prototype of exactly the root aggregate the new architecture calls `communities` — and
it never shipped to production.

**2. Test is missing both of production's worst collection hazards.** Zero duplicate
tier names, zero tier entries without an `id`. Production has 23 duplicate groups
across 5 collections and 200 of 305 entries missing an id. **Validating a migration
against test would show tiers as clean.**

**3. `deposits` is empty.** 0 rows, against 6,201 in production. The table that
carries every provider transaction in production holds nothing here.

---

## 2. Schema structure

| Schema | Tables | Views | Sequences |
|---|---|---|---|
| `public` | **54** | **2** | 2 |
| `auth` | 27 | 0 | 1 |
| `storage` | 8 | 0 | 0 |
| `realtime` | 7 | 0 | 1 |
| `cron` | 2 | 0 | 2 |
| `net` | 2 | 0 | 1 |
| `supabase_migrations` | 1 | 0 | 0 |
| `vault` | 1 | 1 | 0 |

`public`: **2 enums, 0 domains, 12 triggers, 96 functions, 8 extensions.**

**No domains** — as in production, there is no `app.kobo` equivalent, so money is
`numeric`.

### Migration tracking

| | Test | Production |
|---|---|---|
| Versions | **85** | 39 |
| Earliest | `20260403161436` | `20260514201017` |
| Latest | `20260828062558` | `20260918101428` |

Test carries **more than twice** as many tracked versions, beginning **earlier** and
ending **earlier**. Test stopped receiving migrations around 2026-08-28 while
production continued to 2026-09-18. The two sets are not a superset/subset
relationship in either direction.

---

## 3. Row counts — 54 tables, 2,585 rows total

| Table | Rows | | Table | Rows |
|---|---|---|---|---|
| `email_campaign_recipients` | 244 | | `campaigns` | 22 |
| **`workspace_members`** | **227** | | `email_campaigns` | 22 |
| `contributions` | 203 | | `ambassador_email_logs` | 19 |
| **`workspaces`** | **176** | | `verification_documents` | 18 |
| `admin_events` | 175 | | `user_identity` | 15 |
| `push_notification_events` | 165 | | `email_campaign_attachments` | 14 |
| `email_campaign_audit_log` | 131 | | `students` | 12 |
| `notifications` | 121 | | `email_test_sends` | 11 |
| `profiles` | 101 | | `push_subscriptions` | 9 |
| `collections` | 95 | | **`workspace_invites`** | **9** |
| `payment_recovery_log` | 87 | | `campaign_donations` | 8 |
| `settlement_runs` | 80 | | `email_templates` | 8 |
| `wallets` | 80 | | `ambassador_influenced_organizers` | 7 |
| `kyc_files` | 77 | | `collection_transfer_requests` | 7 |
| `pending_payment_context` | 63 | | `ambassador_applications` | 6 |
| `kyc_documents` | 58 | | `ambassador_resources` | 6 |
| **`wallets_backup_20260717`** | **56** | | `collection_access_grants` | 6 |
| `contribution_code_counters` | 54 | | `payout_accounts` | 6 |
| `campuses` | 43 | | `ambassador_profiles` | 5 |
| `withdrawals` | 43 | | `ambassador_withdrawals` | 5 |
| `kyc_verification_history` | 36 | | `ambassador_payout_accounts` | 4 |
| `collection_access_invite_items` | 31 | | `admin_users` | 3 |
| `campaign_images` | 29 | | `password_reset_otps` | 3 |
| `collection_access_invites` | 27 | | `transfer_recipients` | 1 |
| `email_change_requests` | 27 | | **`deposits`** | **0** |
| `password_change_otps` | 26 | | `email_unsubscribes` | 0 |
| `kyc_verifications` | 23 | | `payment_admin_actions` | 0 |

**Test-only tables (4):** `workspaces`, `workspace_members`, `workspace_invites`,
`wallets_backup_20260717`.

Notably, **every ambassador table has rows in test** (5 of 6 are empty in
production), as do `campaign_donations`, `collection_access_*`,
`collection_transfer_requests`, `email_change_requests` and `password_reset_otps` —
all empty in production. Test exercised features production never used.

---

## 4. The workspace model

The most migration-relevant structure in either legacy project.

```
workspaces          id, name, slug, type, status, owner_id, created_by,
                    created_at, updated_at, description
workspace_members   id, workspace_id, user_id, role, status, invited_by,
                    joined_at, created_at, updated_at
workspace_invites   id, workspace_id, email(citext), role, token_hash, status,
                    invited_by, expires_at, accepted_at, accepted_by,
                    revoked_at, revoked_by, created_at
```

| Distribution | Values |
|---|---|
| `workspaces.type` | **personal 98**, organization 72, community 3, association 2, group 1 |
| `workspaces.status` | active 176 (all) |
| `workspace_members.role` | OWNER 163, ADMIN 33, MEMBER 31 |
| `workspace_members.status` | active 227 (all) |
| `workspace_invites.status` | ACCEPTED 6, REVOKED 3 |

**98 personal workspaces for 98 distinct owners — exactly one each, auto-created.**
The trigger that does it is `ensure_personal_workspace()`, and this is precisely the
new architecture's COM-01 behaviour, where a new sign-up receives a personal community
immediately.

**93 of 95 collections carry a `workspace_id`**, with zero orphan references. Only 24
distinct users own collections, against 98 workspace owners — so workspaces were
provisioned per user regardless of whether they ever collected money.

`workspace_invites.token_hash` stores a **hash, not a token** — the same decision the
new schema makes (SEC-20b).

**Why this matters:** the new architecture's `communities` + `officer_terms` +
`invite_links` is not a departure from legacy thinking. Legacy had already designed it,
built it in test, and stopped before production. What it does *not* do is solve
production's problem: **production has no workspaces at all**, so the migration must
still create a community for each of production's 275 collections. The value here is
evidential — it shows the intended direction, and it is a usable migration fixture.

---

## 5. Authentication

| Figure | Test | Production |
|---|---|---|
| `auth.users` | **104** | 623 |
| soft-deleted | 0 | 0 |
| with email | 104 (100%) | 623 (100%) |
| **with phone** | **0** | **0** |
| email confirmed | 85 (82%) | 426 (68%) |
| `auth.identities` | 104 | 623 |
| `profiles` | **101** | 622 |
| profiles with no auth user | 0 | 0 |
| auth users with no profile | **3** | 1 |

**`auth.users.phone` is empty in both environments.** This independently confirms the
production finding: legacy authentication is email-only, and phone numbers live in
`profiles.phone_number`. F-M1 is a `profiles` question, not an `auth` one, in both
environments.

---

## 6. Financial structures

| Entity | Test rows | Test total | Production rows |
|---|---|---|---|
| `contributions` | 203 (**all `paid`**) | ₦51,317,804.00 | 5,576 |
| **`deposits`** | **0** | — | 6,201 |
| `withdrawals` | 43 | ₦572,281.00 | 292 |
| `wallets` | 80 | available ₦50,897,048.09 | 245 |
| `payout_accounts` | 6 | — | 26 |
| `payment_admin_actions` | **0** | — | 220 |
| `pending_payment_context` | 63 | — | 797 |
| `settlement_runs` | 80 | — | 56 |
| `payment_recovery_log` | 87 | — | 30,242 |

Wallet columns: gross ₦51,407,753.96 · net ₦51,286,848.09 · withdrawn ₦391,800.00 ·
available ₦50,897,048.09.

**Money precision is exact here too** — zero values over 2 decimal places, zero
negatives, in both `contributions.amount` and `withdrawals.amount`. The
naira→kobo conversion rule holds in both environments.

**Test's drift is different, and larger.** `wallets.net_payment` (₦51,286,848.09) is
**₦30,955.91 below** the sum of paid contributions (₦51,317,804.00). Production's drift
is **₦3.59 above**. Different magnitude, opposite direction. **Test cannot be used to
validate drift behaviour.**

`wallets.withdrawn` (₦391,800.00) equals the `approved` withdrawal total exactly
(₦391,800.00) — so in test, as in production, the wallet counts `approved` as money
gone. This is corroborating evidence for the production question F-L5.

**`deposits` being empty is the most consequential financial difference.** In
production `deposits` is the provider-transaction record and the source of the 1,317
unattributed payments. In test it holds nothing, so the entire attribution problem —
the ₦19.8m matter — has no analogue here and cannot be rehearsed against test.

### Withdrawal status — a different vocabulary

| Status | Test rows | Total |
|---|---|---|
| `approved` | 26 | ₦391,800.00 |
| **`pending`** | 5 | ₦102,798.00 |
| **`owner_rejected`** | 4 | ₦3,750.00 |
| **`pending_owner_approval`** | 4 | ₦4,000.00 |
| `rejected` | 4 | ₦69,933.00 |

Test has `pending`, `pending_owner_approval` and `owner_rejected`, none of which exist
in production. Test has **no `success`**, which production has 43 of.

`pending_owner_approval` and `owner_rejected` are an **owner-approval workflow
prototype** — conceptually the same thing as the new architecture's D-06 approval
tiers. Like workspaces, it was built in test and never reached production.

The absence of `success` in test is also evidence: production's `success` runs
2025-06-07→2025-12-08 and stops, `approved` runs 2025-12-19 onward, and the newer test
environment uses only `approved`. `success` is retired vocabulary.

---

## 7. Collection model

`collections` has **41 columns = production's 40 plus `workspace_id uuid NULL`.**
Everything else matches, including the `type`/`collection_type` pair, `amount numeric`,
and all five jsonb columns.

| Distribution | Test | Production |
|---|---|---|
| `collection_type` | fixed 57, fundraising 11, tiered 11, open_pool 8, ticket 8 | fixed 173, tiered 74, fundraising 13, open_pool 11, ticket 4 |
| `type` | flat 36, **normal 25**, tiered 15, fundraising 11, open_pool 8 | **fixed 151**, tiered 79, flat 21, fundraising 13, open_pool 11 |
| `status` | active 91, closed 2, **pending_review 2** | active 237, closed 21, **deleted 12, paused 4, rejected 1** |
| `fee_bearer` | contributor 63, organizer 32 | contributor 204, organizer 71 |
| `currency` | NGN 95 (all) | NGN 275 (all) |

**`collection_type` uses the same five values in both environments. `type` does not:**
`normal` is test-only, `fixed` is production-only.

**This materially strengthens the production recommendation on F-L3.** A column whose
vocabulary is stable across both environments is the better candidate for authority;
`type` drifts per environment and carries three different names for the same idea
(`fixed`, `flat`, `normal`).

Cross-tab, showing the same pattern as production:

| `type` | `collection_type` | Rows | With tiers |
|---|---|---|---|
| flat | fixed | 33 | 0 |
| **normal** | fixed | 24 | 0 |
| fundraising | fundraising | 11 | 0 |
| tiered | tiered | 10 | 10 |
| open_pool | open_pool | 8 | 0 |
| tiered | ticket | 5 | 5 |
| flat | **ticket** | 3 | **0** |
| **normal** | tiered | 1 | 1 |

The `ticket`-with-no-tiers anomaly appears here too (3 rows, versus 1 in production),
so it is a systematic pattern rather than isolated corruption.

### Tiers — clean in test

| Check | Test | Production |
|---|---|---|
| tier entries | 36 | 305 |
| collections with tiers | 16 | 79 |
| **duplicate name groups** | **0** | **23** |
| **entries without `id`** | **0** | **200** |
| key set | identical | identical |

Same eight keys (`id`, `name`, `price`, `prefix`, `description`, `quantity`,
`remaining_quantity`, `sold_quantity`), and **both hazards absent.**

---

## 8. Referential integrity — clean

| Check | Result |
|---|---|
| contributions with null collection | 0 |
| contributions → missing collection | 0 |
| collections → missing auth user | 0 |
| withdrawals with null collection | 0 |
| wallets → missing collection | 0 |
| collections → missing workspace | 0 |
| profiles → missing auth user | 0 |

No orphans anywhere. With `deposits` empty, test has **no unattributed-payment
problem at all**.

---

## 9. Security

### Test is *better* than production on table grants

| Role | Test | Production |
|---|---|---|
| `anon` | **SELECT only**, 53 tables | SELECT 49 + **INSERT/UPDATE/DELETE/TRUNCATE on 10** |
| `authenticated` | **SELECT only**, 54 tables | SELECT 50 + UPDATE on 15, INSERT on 11, DELETE/TRUNCATE on 10 |

**Neither role holds a single write privilege anywhere in test.** Production's
`anon` TRUNCATE grant on `settlement_runs` and `wallets_backup_20260805` has no
counterpart here.

### Test is *worse* than production on function grants — T-S1 · **MEDIUM-HIGH**

**Three functions are both SECURITY DEFINER and anon-executable. Production has zero.**

| Function | Writes | Exposure |
|---|---|---|
| `ensure_personal_workspace()` | yes | A **trigger** function; calling it directly fails for want of trigger context. Low practical risk, same class as an M8.1 finding in the new repo. |
| `get_historical_orphaned_payments_summary()` | no | Returns orphan count, gross, net and date range. Anonymously readable aggregate financial data. |
| **`get_overwithdrawn_collections_reconciliation()`** | no | Returns **per-collection** id, title, genuine net, withdrawn, difference, counts and classification. SECURITY DEFINER, so it **bypasses RLS**. |

The third is the real one: anyone holding the test project's publishable key can
enumerate every collection's title and financial position. In production both read
functions are SECURITY DEFINER but restricted to `authenticated`.

**The 2026-08-05 production lockdown was not applied to test.** Test retains the
exposure class that was the original CRITICAL finding.

### T-S2 · RLS disabled on one table · **MEDIUM**

`email_test_sends` has **RLS disabled** (11 rows). Production has RLS enabled on all
53 tables. Combined with `anon` holding SELECT, this table is anonymously readable
with no row filtering. It holds test email sends, so the content is low-value — but
it is the only table in either environment with RLS off.

RLS is FORCED on 2 tables in test (`admin_users`, `payment_recovery_log`) versus 3 in
production.

### Views

Only **2**, both SECURITY DEFINER, neither granted to `anon`:
`email_recipient_directory` (shared with production) and **`public_collection_view`
(test-only)**.

Test is missing all six of production's payment-diagnostic views and
`v_collections_with_duplicate_tier_names` — consistent with test never having had the
problems those views were built to investigate.

### Secrets — T-SEC: none found in test

**Test's cron jobs contain no credential.** Job 6 (`*/5 * * * *`) posts to an Edge
Function with a `Content-Type` header only — no `X-Cron-Secret`. Production's
equivalent job carries a shared secret in plaintext.

So the cron-secret exposure is **production-only**. No new secret was discovered in
test, and no value from anywhere was printed, copied or committed.

### Scheduled jobs

Two, both **active**, same schedules as production: `*/5 * * * *` (payment recovery)
and `0 4 * * *` (wallet recompute). Test is therefore also mutating, though its
`payment_recovery_log` holds only 87 rows against production's 30,242 — so the
recovery job finds almost nothing to do here.

---

## 10. Migration relevance

**Useful as migration fixtures:**

- **`workspaces` / `workspace_members` / `workspace_invites`** — a real legacy
  workspace→collection shape, better evidence than the synthetic fixtures currently in
  `supabase/tests/23_migration_fixtures.sql`.
- **`collections.workspace_id`** — demonstrates the nullable additive transition
  legacy intended.
- **The withdrawal approval statuses** — a real example of `pending_owner_approval`
  and `owner_rejected`.
- **`collection_access_grants` / `_invites` / `_invite_items`** — populated here (6,
  27, 31) and empty in production, so this is the only place their shape can be
  observed with data.

**Must NOT be copied into the new system:**

- `wallets_backup_20260717` — a test-only snapshot of test balances.
- All test financial data. Test's ₦51.3m of contributions is synthetic, its drift is
  ₦30,955.91 in the opposite direction to production's, and `deposits` is empty.
- The three SECURITY DEFINER + anon function grants.
- The RLS-disabled state of `email_test_sends`.

**Test is not representative of production.** Beyond the version gap, the two worst
production hazards are absent, `deposits` is empty, the attribution problem does not
exist, and the status vocabularies differ in four tables. A migration validated only
against test would pass while being wrong about tiers, deposits, attribution and
statuses.

---

## 11. What was not inspected

Column-level detail for all 54 tables (the migration-relevant ones were inspected
individually); index definitions; check-constraint expressions; foreign-key actions;
sequence states; `storage` buckets and objects; function bodies beyond signatures and
a write-detection pattern; the Edge Function source referenced by cron. All are
read-only and can be captured later.
