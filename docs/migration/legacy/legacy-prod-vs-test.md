# Legacy production vs legacy test

**Captured:** 2026-09-26, both read-only, neither modified.
**Production:** `busfgcmbndleljklrcbd`, eu-central-1, **PostgreSQL 15.8.1.094**
**Test:** `lpeeckqsltxohppheucz`, eu-north-1, **PostgreSQL 17.4.1.064**

Sources: [legacy-production-baseline.md](legacy-production-baseline.md) ·
[legacy-test-baseline.md](legacy-test-baseline.md)

**Classification used throughout:** `PROD ONLY` · `TEST ONLY` · `BOTH / SAME` ·
`SCHEMA DRIFT` · `UNKNOWN`. **Nothing is silently reconciled.** Where the two
environments disagree, both values are recorded and the difference is named.

---

## 0. The conclusion, first

**Legacy test is not a smaller copy of legacy production. It is a different system.**

It is *ahead* of production in features (workspaces, an owner-approval withdrawal
workflow), *behind* it in migration versions' end date, *cleaner* on the two worst
collection hazards, *empty* where production's provider-transaction record is
fullest, and *differently exposed* on security — better on table grants, worse on
function grants.

**A migration validated only against test would pass while being wrong about tiers,
deposits, payment attribution, and four separate status vocabularies.**

The single most valuable thing in test is evidential rather than structural: it
contains a working prototype of the community model the new architecture requires, and
production does not.

---

## 1. Project-level

| Property | Production | Test | Class |
|---|---|---|---|
| Ref | `busfgcmbndleljklrcbd` | `lpeeckqsltxohppheucz` | — |
| Name | kolekto prod | Kolekto test | — |
| Region | **eu-central-1** | **eu-north-1** | SCHEMA DRIFT (infrastructure) |
| **PostgreSQL** | **15.8.1.094** | **17.4.1.064** | **SCHEMA DRIFT** |
| Created | 2025-06-02 | 2025-06-27 | — |
| Organization | `Kolekto Org` | `Kolekto Org` | BOTH / SAME |

### The version difference, explicitly

**Production runs PostgreSQL 15. Test runs PostgreSQL 17. Test is two major versions
ahead of the live system.**

Consequences that matter for this programme:

1. **Test is not a valid rehearsal surface for version-sensitive behaviour.** Anything
   verified on 17 must be re-verified against 15 before it touches production.
2. **Structural differences may be Postgres differences rather than application
   ones.** `realtime` has 7 tables in test and 9 in production, and `extensions` has 2
   views against 4 — these are almost certainly platform, not product. They are
   classified UNKNOWN rather than attributed to either cause.
3. **The new Kolekto system must state which version it targets.** It is developed
   against the Supabase CLI's local stack; whichever new project is created should not
   inherit this split by accident.

---

## 2. Structure

| Metric | Production | Test | Class |
|---|---|---|---|
| public tables | 53 | **54** | SCHEMA DRIFT |
| public views | **8** | **2** | SCHEMA DRIFT |
| public functions | 95 | 96 | SCHEMA DRIFT |
| SECURITY DEFINER functions | 20 | 22 | SCHEMA DRIFT |
| **definer + anon-executable** | **0** | **3** | **SCHEMA DRIFT (security)** |
| public triggers | 9 | 12 | SCHEMA DRIFT |
| enums | 2 | 2 | BOTH / SAME |
| domains | 0 | 0 | BOTH / SAME |
| extensions | 10 | 8 | UNKNOWN (likely platform) |
| sequences | 2 | 2 | BOTH / SAME |
| cron jobs | 2, active | 2, active | BOTH / SAME |
| **migration versions** | **39** | **85** | **SCHEMA DRIFT** |
| migration earliest | `20260514201017` | `20260403161436` | SCHEMA DRIFT |
| migration latest | `20260918101428` | `20260828062558` | SCHEMA DRIFT |

**Neither migration set is a subset of the other.** Test begins earlier and ends
earlier; production begins later and continues later. Combined with the production
finding that its schema **predates its own migration tracking**, this means neither
project's schema can be reconstructed from migration files. The live databases are the
only authoritative descriptions, which is exactly why these two baselines exist.

---

## 3. Tables present in one and not the other

### TEST ONLY (4)

| Table | Rows | Significance |
|---|---|---|
| **`workspaces`** | 176 | **A prototype of the new architecture's `communities`** |
| **`workspace_members`** | 227 | Prototype of `officer_terms` |
| **`workspace_invites`** | 9 | Prototype of `invite_links`, with `token_hash` |
| `wallets_backup_20260717` | 56 | Test-only wallet snapshot |

### PROD ONLY (3)

| Table | Rows | Significance |
|---|---|---|
| `wallets_backup_20260805` | 240 | Forensic snapshot from the 2026-08-05 incident |
| `payment_reference_backfill_snapshot_20260811` | 3,324 | Forensic snapshot |
| `duplicate_void_snapshot_20260812` | 12 | Forensic snapshot |

**The three production-only tables are all forensic snapshots of real incidents. The
three meaningful test-only tables are all unshipped features.** That asymmetry
summarises the relationship between the two environments: production accumulated
evidence of things going wrong, test accumulated prototypes of things not yet built.

### Shared tables where data presence differs sharply

| Table | Production | Test | Class |
|---|---|---|---|
| **`deposits`** | **6,201** | **0** | **SCHEMA DRIFT (data)** |
| `payment_admin_actions` | 220 | **0** | data drift |
| `payment_recovery_log` | 30,242 | 87 | data drift |
| `settlement_runs` | 56 | 80 | data drift (test has *more*) |
| `email_change_requests` | 0 | 27 | TEST ONLY in practice |
| `password_reset_otps` | 0 | 3 | TEST ONLY in practice |
| `campaign_donations` | 0 | 8 | TEST ONLY in practice |
| `collection_access_grants` | 0 | 6 | TEST ONLY in practice |
| `collection_access_invites` | 0 | 27 | TEST ONLY in practice |
| `collection_access_invite_items` | 0 | 31 | TEST ONLY in practice |
| `collection_transfer_requests` | 0 | 7 | TEST ONLY in practice |
| `ambassador_profiles` | 0 | 5 | TEST ONLY in practice |
| `ambassador_withdrawals` | 0 | 5 | TEST ONLY in practice |
| `ambassador_payout_accounts` | 0 | 4 | TEST ONLY in practice |
| `ambassador_influenced_organizers` | 0 | 7 | TEST ONLY in practice |
| `ambassador_resources` | 0 | 6 | TEST ONLY in practice |

**`deposits` is the most consequential.** In production it is the provider-transaction
record — 6,201 rows, ₦90m gross, and the source of all 1,317 unattributed payments. In
test it is empty. **Production's entire payment-attribution problem has no analogue in
test and cannot be rehearsed there.**

Eleven tables are empty in production but populated in test, so test is the **only
place several legacy shapes can be observed with real data** — see §9.

---

## 4. Column-level differences

| Table | Difference | Class |
|---|---|---|
| `collections` | Test has **41 columns**: production's 40 **plus `workspace_id uuid NULL`** | **SCHEMA DRIFT** |
| `collections` | All other 40 columns identical, including the `type`/`collection_type` pair, `amount numeric`, and all five jsonb columns | BOTH / SAME |
| `profiles` | Identical in both (17 columns) | BOTH / SAME |
| `contributions`, `withdrawals`, `wallets`, `deposits`, `payout_accounts`, `pending_payment_context`, `settlement_runs` | No differences observed | BOTH / SAME |

`collections.workspace_id` being **nullable** is itself informative: legacy's own
transition plan was additive and backwards-compatible. The new architecture's
`community_id not null` is the completion of that transition.

---

## 5. Status and type vocabularies — four tables disagree

This is where silent reconciliation would do the most damage.

### `collections.type`

| Value | Production | Test | Class |
|---|---|---|---|
| `fixed` | **151** | **absent** | **PROD ONLY** |
| `normal` | **absent** | **25** | **TEST ONLY** |
| `flat` | 21 | 36 | BOTH / SAME |
| `tiered` | 79 | 15 | BOTH / SAME |
| `fundraising` | 13 | 11 | BOTH / SAME |
| `open_pool` | 11 | 8 | BOTH / SAME |

**Three different names for "a fixed-price collection" across the estate:** `fixed`
(prod), `flat` (both), `normal` (test).

### `collections.collection_type`

| Value | Production | Test | Class |
|---|---|---|---|
| `fixed` | 173 | 57 | BOTH / SAME |
| `tiered` | 74 | 11 | BOTH / SAME |
| `fundraising` | 13 | 11 | BOTH / SAME |
| `open_pool` | 11 | 8 | BOTH / SAME |
| `ticket` | 4 | 8 | BOTH / SAME |

**`collection_type` uses the identical five values in both environments.**

> **This settles the evidence for production's open question F-L3.** `collection_type`
> has a stable vocabulary across both environments; `type` drifts per environment and
> carries three synonyms for one idea. A column whose meaning survives an environment
> change is the better candidate for authority. **It remains a founder decision** — but
> the evidence now points one way rather than being balanced.

### `collections.status`

| Value | Production | Test | Class |
|---|---|---|---|
| `active` | 237 | 91 | BOTH / SAME |
| `closed` | 21 | 2 | BOTH / SAME |
| `deleted` | **12** | **absent** | **PROD ONLY** |
| `paused` | **4** | **absent** | **PROD ONLY** |
| `rejected` | **1** | **absent** | **PROD ONLY** |
| `pending_review` | **absent** | **2** | **TEST ONLY** |

The three production-only statuses are precisely the ones needing migration exceptions
(E-COL-1 for the 12 soft-deleted). **None can be rehearsed against test.**

### `withdrawals.status`

| Value | Production | Test | Class |
|---|---|---|---|
| `approved` | 239 (₦41.65m) | 26 (₦391,800) | BOTH / SAME |
| `success` | **43 (₦4.55m)** | **absent** | **PROD ONLY** |
| `rejected` | 10 | 4 | BOTH / SAME |
| `pending` | **absent** | **5** | **TEST ONLY** |
| `pending_owner_approval` | **absent** | **4** | **TEST ONLY** |
| `owner_rejected` | **absent** | **4** | **TEST ONLY** |

> **This strengthens the evidence for production's open question F-L5.** Production's
> `success` runs 2025-06-07→2025-12-08 and then stops; `approved` runs 2025-12-19
> onward. The newer test environment uses **only `approved`** and has no `success` at
> all. Combined with `wallets.withdrawn` equalling the `approved` total exactly in
> *both* environments, the reading that `approved` is the terminal paid state and
> `success` is retired vocabulary is now supported by three independent lines of
> evidence. **Still a founder decision** — ₦41.6m depends on it.

`pending_owner_approval` and `owner_rejected` are an **owner-approval workflow
prototype**, conceptually the new architecture's D-06 approval tiers, built in test and
never shipped.

### `contributions.status`

| Value | Production | Test | Class |
|---|---|---|---|
| `paid` | 3,934 | 203 | BOTH / SAME |
| `pending` | **1,628** | **absent** | **PROD ONLY** |
| `duplicate_voided` | **14** | **absent** | **PROD ONLY** |

---

## 6. Data-shape differences

| Property | Production | Test | Class |
|---|---|---|---|
| Money storage | `numeric`, naira | `numeric`, naira | BOTH / SAME |
| Values over 2 decimal places | **0** | **0** | BOTH / SAME |
| Negative amounts | **0** | **0** | BOTH / SAME |
| Currency | NGN only | NGN only | BOTH / SAME |
| Tier jsonb key set | 8 keys | identical 8 keys | BOTH / SAME |
| **Duplicate tier names** | **23 groups / 5 collections** | **0** | **SCHEMA DRIFT (data)** |
| **Tier entries without `id`** | **200 of 305** | **0 of 36** | **SCHEMA DRIFT (data)** |
| **Unattributed deposits** | **1,317 (₦28.9m; 923 success = ₦19.8m)** | **0** (no deposits) | **SCHEMA DRIFT (data)** |
| `auth.users.phone` populated | 0 | 0 | BOTH / SAME |
| Referential orphans | 0 | 0 | BOTH / SAME |
| Wallet drift vs contributions | **+₦3.59** | **−₦30,955.91** | **SCHEMA DRIFT (data)** |
| `wallets.pending_balance` | 0.00 all rows | — | — |
| `is_organizer` populated | false on all 622 | — | — |

**The naira→kobo conversion rule holds in both environments:** nothing anywhere exceeds
two decimal places and nothing is negative, so `round(v*100)` is exact everywhere. This
is the one substantive property that generalises.

**Everything else about the financial data does not generalise.** Both of production's
tier hazards are absent from test, the attribution problem is absent, and the drift
differs in both magnitude and sign.

---

## 7. Security differences — drift runs both ways

| Control | Production | Test | Class |
|---|---|---|---|
| RLS enabled | **53 / 53** | **53 / 54** — `email_test_sends` **off** | **SCHEMA DRIFT** |
| RLS forced | 3 | 2 | SCHEMA DRIFT |
| `anon` SELECT | 49 tables | 53 tables | SCHEMA DRIFT |
| **`anon` write grants** | **INSERT/UPDATE/DELETE/TRUNCATE on 10 tables** | **none** | **SCHEMA DRIFT** |
| **`authenticated` write grants** | UPDATE on 15, INSERT on 11, DELETE/TRUNCATE on 10 | **none** | **SCHEMA DRIFT** |
| **definer + anon functions** | **0** | **3** | **SCHEMA DRIFT** |
| definer views granted to anon | 0 | 0 | BOTH / SAME |
| **Secret in `cron.job`** | **yes — shared secret, jobid 5** | **no** | **PROD ONLY** |

**Neither environment is uniformly safer.**

**Production's worst finding:** `anon` holds **TRUNCATE** on 10 tables including
`settlement_runs` and `wallets_backup_20260805`. RLS blocks INSERT/UPDATE/DELETE but
**does not apply to TRUNCATE**, so the grant is directly usable with the publishable
key. Test has no write grant of any kind.

**Test's worst finding:** three functions are SECURITY DEFINER *and* anon-executable.
The significant one is `get_overwithdrawn_collections_reconciliation()`, which returns
per-collection titles, net amounts, withdrawn amounts and over-withdrawal differences
while bypassing RLS. In production the same function is definer but restricted to
`authenticated`.

**The clear inference: the 2026-08-05 production security lockdown was applied to
production and not to test.** Production closed the definer+anon hole and test still
has it; production's broad table grants are the older posture that test never
acquired. The estate was hardened in one place at a time.

**Secrets:** production's payment-recovery cron job carries a shared secret in
plaintext in `cron.job.command`. Test's equivalent job carries only a `Content-Type`
header. **No new secret was found in test.** No value from either environment was
printed, copied or committed.

---

## 8. Functions and views

| | Production | Test | Class |
|---|---|---|---|
| Payment diagnostic views | **6** (`v_payment_health_summary`, `v_payment_inbox`, `v_payment_invariants`, `v_payment_mismatch_rate`, `v_payment_recovery_exhausted`, `v_orphaned_successful_payments`) | **absent** | **PROD ONLY** |
| `v_collections_with_duplicate_tier_names` | present | **absent** | **PROD ONLY** |
| `email_recipient_directory` | present | present | BOTH / SAME |
| `public_collection_view` | **absent** | present | **TEST ONLY** |
| `ensure_personal_workspace()` | **absent** | present | **TEST ONLY** |
| `record_payment_capture`, `mark_payment_completed`, `mark_payment_needs_review`, `claim_payment_contributions`, `settlement_recompute_wallets`, `request_withdrawal_atomic`, `approve_withdrawal_atomic` | present | present (not individually re-verified) | BOTH / SAME |

**Production's seven extra views are all forensic.** They exist because production had
the problems; test never needed them. Their absence from test is another reason test
cannot validate a migration: the very diagnostics that would reveal the hazards are
not there.

---

## 9. Migration implications

### Test is useful for exactly four things

1. **The workspace model as a migration fixture.** `workspaces` (176),
   `workspace_members` (227), `workspace_invites` (9) and `collections.workspace_id`
   give a real legacy workspace→collection shape — better evidence than the synthetic
   fixtures in `supabase/tests/23_migration_fixtures.sql`.
2. **Evidence for F-L1.** Test auto-created **exactly one personal workspace per
   owner** (98/98) via `ensure_personal_workspace()`, which is the new architecture's
   COM-01 behaviour. That is what legacy itself chose when it solved this problem.
3. **Evidence for F-L3 and F-L5**, per §5.
4. **The only place to observe eleven legacy shapes with data** — the ambassador
   tables, `campaign_donations`, `collection_access_*`,
   `collection_transfer_requests`, `email_change_requests`, `password_reset_otps` are
   all empty in production and populated in test. If those shapes need a destination,
   test is where to see them.

### Test must not be used for

- **Validating tier migration.** Zero duplicate names, zero missing ids. Production's
  5 blocked collections and 200 id-less entries would go unnoticed.
- **Validating deposit or attribution migration.** `deposits` is empty; the ₦19.8m
  problem does not exist here.
- **Validating status mapping.** Four tables have different vocabularies, and every
  status needing a migration exception (`deleted`, `paused`, `rejected`, `pending`,
  `duplicate_voided`, `success`) is **production-only**.
- **Validating drift behaviour.** ₦3.59 versus −₦30,955.91.
- **Any control total.** Production is 20× larger and differently shaped.
- **Any version-sensitive behaviour.** PostgreSQL 15 versus 17.

### Neither environment's schema should be copied

Both are additive-drift artefacts of a system that outgrew its migration tracking. The
new schema is already built. These baselines are for **understanding and mapping**, not
for replication.

### New exception, from this comparison

**`X-29` · The workspace prototype has no migration destination.** 176 workspaces, 227
memberships and 9 invites exist in test and nowhere in production. If the founder wants
them preserved — they are test data, so arguably not — they need a destination like
everything else under zero data loss.

**My reading:** this is *test* data describing a prototype, not customer records, so
`migration.legacy_overflow` with `source_project` recording that it came from the test
project is sufficient. Its **structural** value as a fixture is real; its **row** value
is low. **Founder decision, F-L6.**

---

## 10. Difference register

| # | Difference | Class | Migration impact |
|---|---|---|---|
| D-1 | PostgreSQL 15 vs 17 | SCHEMA DRIFT | Test invalid for version-sensitive rehearsal |
| D-2 | `workspaces`/`_members`/`_invites` | TEST ONLY | Fixture source; evidence for F-L1 |
| D-3 | `collections.workspace_id` | TEST ONLY | Shows the intended transition |
| D-4 | 3 forensic snapshot tables | PROD ONLY | Must be preserved; no test analogue |
| D-5 | `wallets_backup_20260717` | TEST ONLY | Do not migrate |
| D-6 | `deposits` empty in test | SCHEMA DRIFT (data) | **Attribution cannot be rehearsed** |
| D-7 | Duplicate tier names | PROD ONLY (data) | **5 collections blocked; invisible in test** |
| D-8 | 200 tier entries without id | PROD ONLY (data) | Invisible in test |
| D-9 | `type`: `fixed` vs `normal` | SCHEMA DRIFT | 3 synonyms across the estate |
| D-10 | `collection_type` identical | BOTH / SAME | **Evidence for F-L3** |
| D-11 | `status`: deleted/paused/rejected | PROD ONLY | All exceptions are prod-only |
| D-12 | `status`: `pending_review` | TEST ONLY | No production analogue |
| D-13 | `withdrawals.status`: `success` | PROD ONLY | **Evidence for F-L5** |
| D-14 | `withdrawals.status`: owner-approval trio | TEST ONLY | Prototype of D-06 tiers |
| D-15 | `contributions.status`: pending, duplicate_voided | PROD ONLY | Exceptions prod-only |
| D-16 | 6 payment views + tier-name view | PROD ONLY | Diagnostics absent from test |
| D-17 | `public_collection_view` | TEST ONLY | — |
| D-18 | `anon` TRUNCATE on 10 tables | PROD ONLY | **Security, HIGH** |
| D-19 | 3 definer+anon functions | TEST ONLY | **Security, MEDIUM-HIGH** |
| D-20 | RLS off on `email_test_sends` | TEST ONLY | Security, MEDIUM |
| D-21 | Cron shared secret | PROD ONLY | **Secret, HIGH, rotate** |
| D-22 | 39 vs 85 migration versions | SCHEMA DRIFT | Neither reproduces its schema |
| D-23 | 11 tables populated only in test | TEST ONLY (data) | Only place to observe those shapes |
| D-24 | Wallet drift +₦3.59 vs −₦30,955.91 | SCHEMA DRIFT (data) | Test cannot validate drift |
| D-25 | `realtime` 9 vs 7 tables; `extensions` 4 vs 2 views | UNKNOWN | Likely platform, not product |
| D-26 | 10 vs 8 extensions | UNKNOWN | Not investigated per-extension |

**Three differences are classified UNKNOWN and left unresolved** (D-25, D-26). They are
most likely artefacts of the PostgreSQL version and Supabase platform difference rather
than application choices, but that was not verified, and guessing would be exactly the
silent reconciliation this document exists to avoid.
