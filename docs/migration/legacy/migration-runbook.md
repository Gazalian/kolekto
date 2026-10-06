# Migration runbook

**Status:** plan. **No migration has been run and no migration code exists.**
**Scope:** how the legacy → new migration executes, in what order, with what
checks, and how it resumes after failure.

**Companions:** [mapping](legacy-to-new-mapping.md) ·
[data-loss policy](migration-data-loss-policy.md) ·
[exceptions](legacy-migration-exceptions.md) ·
[control totals](legacy-control-totals.md) ·
[validation contract](../../phase-4/migration-validation-contract.md)

---

## 1. Preconditions — every one is a hard gate

| # | Gate | Status |
|---|---|---|
| G1 | New staging Supabase project exists | **not created** |
| G2 | New production Supabase project exists, with PITR | **not created** |
| G3 | `migration.legacy_withdrawal` created (F-M2) | **not created** — E-W1 |
| G4 | `migration.legacy_overflow` created | **not created** — E-O1 |
| G5 | `source_project` added to `migration.import_runs` | **not added** — E-P1 |
| G6 | Community strategy decided | **open** — F-L1 |
| G7 | `type` vs `collection_type` authority decided | **open** — F-L3 |
| G8 | Duplicate tier names resolved for 5 collections | **open** — F-L4 |
| G9 | Withdrawal `approved` semantics confirmed | **open** — F-L5 |
| G10 | `user_identity` / KYC ruling from counsel | **open** — L-1 |
| G11 | Bank-detail retention ruling | **open** — L-3 |
| G12 | `payout_accounts` decryption key located | **open** — E-K1 |
| G13 | A fresh control-total capture, taken immediately before the run | this baseline is 2026-09-26 and will be stale |

**No migration may begin until G1–G13 are closed.** Nine of the thirteen are
decisions, not engineering.

---

## 2. Order of execution

Dependency-forced. Each step is one transaction where possible, and each ends with
its control-total check.

```
 0. open import_run (status='running', source_project, snapshot label)
 1. auth users            623   → UUIDs PRESERVED
 2. public.users          622   ← profiles
 3. communities             ?   ← one per organizer (F-L1)
 4. officer_terms           ?   ← owner per community, start_reason='migration'
 5. collections           275   → is_imported, provenance, ×100 to kobo
 6. collection_tiers      305   ← price_tiers jsonb (F-L4 blocks 5 collections)
 7. collection_fields       ?   ← contributions_fields jsonb
 8. collection_code_sequences 53 ← contribution_code_counters (seed next_number)
 9. members             ~3,353  ← distinct contributors, status 'unclaimed'
10. member_contacts         ?   ← contributor_information
11. legacy_links            ?   ← slugs, receipts, contributor codes
12. legacy_profile        622   → overflow fields
13. legacy_collection     275   → overflow fields
14. legacy_contribution 5,576   → verbatim, status preserved
15. legacy_deposit      4,884   → attributed deposits
16. unattributed_payments 1,317 → NO collection_id, ever
17. legacy_withdrawal     292   → immutable (G3)
18. legacy_overflow    ~40,000  → every remaining table (G4)
19. reconciliation report
20. close import_run (status='completed')
```

**Steps 1 and 2 are the riskiest**, because auth UUID preservation is the one thing
that cannot be corrected afterwards: a user whose UUID changed has lost their
history, and re-running will not fix it.

**Step 18 is the largest** — `payment_recovery_log` alone is 30,242 rows.

**No step posts a ledger journal.** There is no step that does.

---

## 3. Resumability

The scenario the brief names: the run stops at `collections 275/275,
contributions 4000/5576`. Restarting must not duplicate anything.

Every step uses `insert … on conflict (<idempotency key>) do nothing`, and every key
is backed by a real unique index — so resumability is an enforced property, not a
convention the pipeline is trusted to follow.

| Step | Idempotency key | Index exists today? |
|---|---|---|
| auth users, `public.users` | `id` | yes (PK) |
| collections, members | `(source_table, source_id) where is_imported` | **yes**, partial unique |
| `legacy_*` overflow tables | `(source_table, source_id)` | **yes**, unique |
| `unattributed_payments` | `(source_table, source_id)` | **yes**, unique |
| `legacy_withdrawal` | `(source_table, source_id)` | with G3 |
| `legacy_overflow` | `(source_project, source_schema, source_table, source_id)` | with G4 |
| tiers | `(collection_id, lower(name))` | yes — **and this is what X-2 violates** |
| code sequences | `collection_id` | yes |

**Restart procedure:** re-run the same command with the **same `import_run_id`**. A
new run id would re-import everything under new provenance, which is the one way to
turn a resumable migration into a duplicating one.

**On failure:** set the run's status to `failed`, leave the imported rows in place
(they are idempotent and immutable), fix the cause, resume with the same run id. A
run left in `running` for ever is a failed run nobody closed, and must be visible as
such.

---

## 4. Verification after each step

Two checks per step. Both must pass before continuing.

1. **Count:** target count equals expected count from
   [legacy-control-totals.md](legacy-control-totals.md) §5, or the difference is
   explained and listed.
2. **The three zeros:** `select count(*) from ledger_journals` = 0,
   `ledger_entries` = 0, and no collection reports a non-zero position.

Plus, at the end:

| Check | Expected |
|---|---|
| auth UUIDs identical in source and target | **623/623** |
| profiles with no phone, preserved | 13 |
| auth user with no profile, preserved | 1 |
| unattributed payments with a collection | **0** |
| imported rows with no `import_run_id` | **0** |
| `sum(amount_kobo)` on legacy withdrawals | **4,668,287,280** |
| tables reported on | **53 of 53** |

---

## 5. Rollback

**The new production database is the only thing that can be rolled back.** Legacy is
read-only and untouched, so there is nothing to undo there — which is the main
safety property of this whole design.

| Scenario | Action |
|---|---|
| Failure mid-run, resumable | Resume with the same run id |
| Failure requiring a clean retry, **before** the new system serves traffic | PITR restore to the pre-migration point, then re-run |
| Failure **after** the new system serves traffic | **No clean rollback.** New activity and imported history would both be lost by a restore. This is why G2 (PITR) and a pre-migration restore point are gates. |
| Wrong data imported but structurally valid | Imported rows are immutable. Correction is a **new** import run with corrected provenance, never an edit — the same rule the ledger uses. |

**Take a PITR restore point immediately before step 1 and record its timestamp in
the run's notes.** Without it the third row of that table has no remedy.

---

## 6. Rehearsal ladder

The first time this runs against real data must not be the first time it runs.

| Stage | Data | Target | Status |
|---|---|---|---|
| 1 | Synthetic fixtures | local | **done** — 43 assertions passing in `23_migration_fixtures.sql` |
| 2 | Larger synthetic set at production volumes | local | not done |
| 3 | Read-only snapshot of legacy **test** | new staging | blocked on G1 |
| 4 | Read-only snapshot of legacy **production** | new staging | blocked on G1, and on L-1/L-3 |
| 5 | The real run | new production | blocked on G1–G13 |

**Stage 4 needs care beyond engineering.** It means copying live customer data —
including 622 profiles, 3,353 contributor identities and bank details — into a
staging environment. That has its own data-protection question and must not happen
casually.

---

## 7. Cutover

Out of scope for this baseline and named so it is not forgotten: **the old system is
live and will still be live on migration day.** Two systems able to take money for
the same organizer needs an explicit plan — which collections are served by which
system, how an organizer is moved, and what happens to a collection mid-cycle.

Two facts from this baseline that reduce the risk:

- **Total unwithdrawn balance across the entire platform is ₦114,038.30.** Of ₦46.7m
  collected historically, almost all has been withdrawn, so there is very little
  live balance to reconcile at switchover.
- **`wallets.pending_balance` is zero in all 245 rows.** Nothing is mid-settlement.

Cutover deserves its own milestone document. This runbook covers the import only.
