# Live production delta strategy

**Legacy production is live and still receiving writes.** This document decides how
records created or changed *after* the baseline snapshot will be captured, so that the
migration loses nothing that arrives during the gap between baseline and cutover.

**Source:** `busfgcmbndleljklrcbd`, discovery 2026-09-27, read-only.
**Nothing was modified. No trigger, column or audit mechanism was added to
production** — the brief forbids it and this is discovery only.

---

## 1. Two findings that shape everything below

### The payment path moved in June 2026

| Month | `deposits` created | `pending_payment_context` created |
|---|---|---|
| 2026-04 | 946 | 0 |
| 2026-05 | 1,255 | 0 |
| **2026-06** | **119** | **169** |
| 2026-07 | **0** | 340 |
| 2026-08 | **0** | 253 |
| 2026-09 | **0** | 35 |

**`deposits` has received no new row since 2026-06-16.** It is a frozen historical
table. `pending_payment_context` took over and is the live payment record.

Three consequences:

1. **`deposits` (6,201 rows) needs no delta strategy for inserts.** Only updates are
   possible, and the last was 2026-06-17.
2. **The 1,317 unattributed deposits (₦28.9m, of which 923 successful = ₦19,799,220)
   cannot grow.** The ₦19.8m matter is closed by arithmetic, not only by policy.
3. **`pending_payment_context` is the delta-critical table** and it is the one with no
   `id` column — its primary key is `reference text`.

### Every id is UUID v4 — so ID-based delta tracking does not exist

Verified across `collections`, `contributions`, `deposits`, `withdrawals` and
`profiles`: **every UUID is version 4.** Random, not time-ordered.

> **`SAFE_BY_MONOTONIC_ID` is unavailable for every table in legacy production.**

There is no `bigserial` anywhere except two tiny sequences (`campuses_campus_id_seq`,
`students_student_id_seq`, both `last_value=2`). So delta detection rests on
**timestamps**, and where timestamps are absent, on **set comparison**. Anyone who
assumed "we'll just take everything above the last id" would be wrong.

---

## 2. Per-table classification

Classification per the brief. `REQUIRES_FINAL_SNAPSHOT` means timestamps cannot
identify what changed, so the table must be re-extracted wholesale at cutover and
compared by primary key.

### Timestamp capability, measured

| Tables | created_at | updated_at |
|---|---|---|
| Have both | 24 | 24 |
| `created_at` only | 17 | — |
| `updated_at` only | 2 | — |
| **Neither** | **11** | |

The 11 with neither: `campuses`, `collection_access_invite_items`,
`email_campaign_attachments`, `email_campaign_recipients`, `email_unsubscribes`,
`kyc_files`, `kyc_verification_history`, `payment_reference_backfill_snapshot_20260811`,
`settlement_runs`, `students`, `verification_documents`.

### Core migration tables

| Table | Rows | created_at | updated_at | Trigger-maintained? | Class |
|---|---|---|---|---|---|
| `auth.users` | 623 | yes | yes | Supabase-managed | **SAFE_BY_UPDATED_AT** |
| `profiles` | 622 | yes | yes | 2 triggers | **SAFE_BY_UPDATED_AT** |
| `collections` | 275 | yes | yes | 3 triggers | **SAFE_BY_UPDATED_AT** |
| `contributions` | 5,576 | yes | yes | 2 triggers | **SAFE_BY_UPDATED_AT** |
| `deposits` | 6,201 | yes | yes | none | **IMMUTABLE_APPEND_ONLY** in practice — frozen since 2026-06-16 |
| `withdrawals` | 292 | yes | yes | none | **SAFE_BY_UPDATED_AT**, with a caveat (§4) |
| `wallets` | 245 | yes | yes | none | **REQUIRES_SPECIAL_HANDLING** — rewritten nightly (§5) |
| `pending_payment_context` | 797 | yes | yes | 1 trigger | **SAFE_BY_UPDATED_AT** — the live payment table |
| `payout_accounts` | 26 | yes | yes | none | SAFE_BY_UPDATED_AT |
| `contribution_code_counters` | 53 | **no** | yes | none | **SAFE_BY_UPDATED_AT** (no created_at, but it is a counter — updates are what matter) |
| `transfer_recipients` | 52 | yes | no | none | **SAFE_BY_CREATED_AT** |
| `user_identity` | 12 | yes | yes | none | SAFE_BY_UPDATED_AT |

### Operational and audit tables

| Table | Rows | Class | Why |
|---|---|---|---|
| `payment_recovery_log` | 30,242 | **SAFE_BY_CREATED_AT** | append-only log, no updated_at |
| `payment_admin_actions` | 220 | **SAFE_BY_CREATED_AT** | append-only audit |
| `admin_events` | 71 | SAFE_BY_CREATED_AT | append-only |
| `notifications` | 172 | SAFE_BY_CREATED_AT | has `read_at`, so rows *do* change — see §4 |
| `push_notification_events` | 173 | SAFE_BY_UPDATED_AT | |
| `push_subscriptions` | 13 | SAFE_BY_UPDATED_AT | |
| `settlement_runs` | 56 | **REQUIRES_FINAL_SNAPSHOT** | **no created_at, no updated_at.** Has `started_at`/`finished_at`, usable as a proxy but not guaranteed |
| `email_campaign_recipients` | 4,710 | **REQUIRES_FINAL_SNAPSHOT** | no timestamp of any kind, 4,710 rows |
| `email_campaign_audit_log` | 96 | SAFE_BY_CREATED_AT | |
| `email_campaigns` | 5 | SAFE_BY_UPDATED_AT | |
| `email_campaign_attachments` | 1 | **REQUIRES_FINAL_SNAPSHOT** | no timestamp |
| `email_templates` | 8 | SAFE_BY_UPDATED_AT | |
| `email_test_sends` | 15 | SAFE_BY_CREATED_AT | |
| `email_unsubscribes` | 0 | **REQUIRES_FINAL_SNAPSHOT** | no timestamp; **suppression data, compliance-relevant** |
| `email_change_requests` | 0 | SAFE_BY_CREATED_AT | |
| `password_change_otps` | 6 | SAFE_BY_CREATED_AT | |
| `password_reset_otps` | 0 | SAFE_BY_CREATED_AT | |

### Compliance and identity

| Table | Rows | Class |
|---|---|---|
| `kyc_verifications` | 21 | SAFE_BY_UPDATED_AT |
| `kyc_documents` | 44 | SAFE_BY_UPDATED_AT (no created_at) |
| `kyc_files` | 53 | **REQUIRES_FINAL_SNAPSHOT** — no timestamp |
| `kyc_verification_history` | 55 | **REQUIRES_FINAL_SNAPSHOT** — no timestamp, and it is *history*, so append-only in practice |
| `verification_documents` | 1 | **REQUIRES_FINAL_SNAPSHOT** — no timestamp |
| `admin_users` | 2 | SAFE_BY_CREATED_AT |

### Subsystems

| Table | Rows | Class |
|---|---|---|
| `campaigns` | 1 | SAFE_BY_UPDATED_AT |
| `campaign_donations` | 0 | SAFE_BY_UPDATED_AT |
| `campaign_images` | 1 | SAFE_BY_CREATED_AT |
| `campuses` | 46 | **REQUIRES_FINAL_SNAPSHOT** — no timestamp, no uuid id |
| `students` | 1 | **REQUIRES_FINAL_SNAPSHOT** — no timestamp, no uuid id |
| `collection_access_grants` | 0 | SAFE_BY_CREATED_AT |
| `collection_access_invites` | 0 | SAFE_BY_CREATED_AT |
| `collection_access_invite_items` | 0 | **REQUIRES_FINAL_SNAPSHOT** — no timestamp |
| `collection_transfer_requests` | 0 | SAFE_BY_CREATED_AT |
| 6 ambassador tables | 2 | SAFE_BY_UPDATED_AT (4) / SAFE_BY_CREATED_AT (2) |

### Forensic snapshots — frozen by definition

| Table | Rows | Class |
|---|---|---|
| `wallets_backup_20260805` | 240 | **IMMUTABLE_APPEND_ONLY** |
| `payment_reference_backfill_snapshot_20260811` | 3,324 | **IMMUTABLE_APPEND_ONLY** (no timestamp, no id — but it is a dated snapshot) |
| `duplicate_void_snapshot_20260812` | 12 | **IMMUTABLE_APPEND_ONLY** |

### Summary

| Class | Tables |
|---|---|
| SAFE_BY_UPDATED_AT | 20 |
| SAFE_BY_CREATED_AT | 13 |
| IMMUTABLE_APPEND_ONLY | 4 |
| **REQUIRES_FINAL_SNAPSHOT** | **11** |
| REQUIRES_SPECIAL_HANDLING | 1 (`wallets`) |
| SAFE_BY_MONOTONIC_ID | **0** |
| UNKNOWN | 0 |

**Every one of the 53 tables is classified.** The 11 requiring a final snapshot total
**8,266 rows**, dominated by `email_campaign_recipients` (4,710) and
`payment_reference_backfill_snapshot_20260811` (3,324). Neither is
financially critical, which is fortunate: the tables that cannot be delta-tracked are
also the ones where a full re-extract is cheap.

---

## 3. High-water mark — captured 2026-09-27

Recorded from a single statement, so the figures are mutually consistent.

**Snapshot instant: `2026-09-27 00:45:19.325890 UTC`**

| Entity | Count | Max `created_at` (UTC) | Max `updated_at` (UTC) |
|---|---|---|---|
| `auth.users` | 623 | — | — |
| `profiles` | 622 | 2026-09-14 18:20:57.462936 | 2026-09-14 18:20:57.462936 |
| `collections` | 275 | 2026-09-23 07:01:42.172203 | **2026-09-26 00:45:13.305** |
| `contributions` | 5,576 | 2026-09-26 00:42:32.658427 | 2026-09-26 00:42:32.658427 |
| `deposits` | 6,201 | **2026-06-16 15:39:03.334941** | 2026-06-17 04:00:04.685868 |
| `withdrawals` | 292 | 2026-09-17 09:01:48.080195 | — |
| `wallets` | 245 | — | **2026-09-26 04:00:00.064726** |
| `payment_recovery_log` | 30,242 | 2026-09-26 00:45:13.238862 | — |

**Observed drift over 24 hours: zero new rows** in any of these tables between the
2026-09-26 baseline and this capture. Production is live but currently low-volume.
That is a helpful fact and **not** a reason to skip the delta design — it is a
measurement of one day, not a guarantee.

**`max(wallets.updated_at) = 2026-09-26 04:00:00`** is the nightly recompute, and it
confirms the 04:00 UTC cron fires. At capture time (00:45 UTC on the 27th) that day's
run had not yet happened.

### Recording rule

The authoritative high-water mark is the one captured **inside the backup dump's own
transaction**, not this one. This capture is the *pattern* and a current reference.
`pg_dump` runs in a repeatable-read transaction; `select now()` plus these maxima inside
that same transaction gives a mark that is exactly consistent with the dumped data.

**Do not invent a mark the database cannot give.** For the 11
`REQUIRES_FINAL_SNAPSHOT` tables, the mark is meaningless — their boundary is "the set
of primary keys present in the dump", which is why they are re-extracted rather than
filtered.

---

## 4. Where `updated_at` is not fully trustworthy

`SAFE_BY_UPDATED_AT` is a statement about the column existing and being maintained, not
a guarantee. Four honest caveats:

**Only 9 triggers exist across 53 tables.** `collections` (3), `contributions` (2),
`profiles` (2), `pending_payment_context` (1), `ambassador_influenced_organizers` (1).
For every other table, `updated_at` is set by **application code**, so a code path that
forgets it produces a silently invisible change. This is not hypothetical in a codebase
that had `wallet += delta` bugs.

**Mitigation:** for financial tables, do not rely on `updated_at` alone at cutover.
Re-extract and compare by primary key. The volumes make this trivial — `withdrawals` is
292 rows, `wallets` 245, `payout_accounts` 26.

**`withdrawals` has no trigger and 139 of 239 `approved` rows have
`created_at = updated_at`** — meaning they were never updated after insert. A withdrawal
whose status changed without `updated_at` moving would be undetectable by timestamp.
**Re-extract all 292 at cutover.**

**`notifications` has `read_at` but no `updated_at`.** A row changes when it is read, and
that change is invisible to `created_at` filtering. Class stays SAFE_BY_CREATED_AT for
*inserts*; read-state changes are accepted as not migration-critical.

**Deletes are invisible to every timestamp strategy.** See §6.

---

## 5. `wallets` requires special handling

`wallets` is rewritten wholesale every night at 04:00 UTC by
`settlement_recompute_wallets('cron')`. So `updated_at` moves on all 245 rows daily,
whether or not anything meaningful changed. Timestamp-based delta detection would flag
the entire table every day and tell you nothing.

**This does not matter**, because of a decision already taken:
**`wallets` never becomes financial truth in the new system.** It is preserved as
history, never as an opening balance (D-23), and the ₦3.59 drift is exactly why.

**Handling:** re-extract all 245 rows at cutover as a final historical snapshot. Do not
attempt incremental tracking. The value being preserved is "what the legacy cache said
at cutover", which is a single point-in-time fact.

---

## 6. Deletes — the gap no timestamp can close

**Are deletes possible? Yes.** And the FK actions make them destructive:

| Constraint | On delete |
|---|---|
| `contributions_collection_id_fkey` | **CASCADE** |
| `wallets_collection_id_fkey` | **CASCADE** |
| `withdrawals_collection_id_fkey` | **CASCADE** |
| `withdrawals_wallet_id_fkey` | **CASCADE** |
| `contribution_code_counters_collection_id_fkey` | **CASCADE** |
| `profiles_id_fkey` (from `auth.users`) | **CASCADE** |
| `user_payout_accounts_user_id_fkey` | **CASCADE** |
| `user_identity_user_id_fkey` | **CASCADE** |
| `kyc_documents_user_id_fkey`, `kyc_verification_history_*` | **CASCADE** |

> **Deleting one collection in legacy production would cascade-delete its
> contributions, its wallet, its withdrawals and its code counter. Deleting one auth
> user would cascade-delete their profile, payout accounts, identity record and KYC
> history.**

**No timestamp or id strategy can detect a delete.** The row is simply gone, and with
`CASCADE` several related rows go with it.

**What mitigates it:**

1. **A delete leaves a hole in the baseline.** Comparing the baseline's primary-key set
   against the final snapshot's finds every deletion — for tables where the baseline is
   retained, which is all of them once D1 exists. **This is a further reason the backup
   is the gate: without it, deletions between now and cutover are undetectable.**
2. **Collections use a soft delete.** Status `deleted` (12 rows) rather than a `DELETE`,
   so the observed practice is not to hard-delete. That is convention, not enforcement.
3. **The new architecture forbids this shape.** It uses `ON DELETE RESTRICT` for
   financial FKs, plus explicit delete guards. The contrast is worth recording: legacy
   can cascade financial history away; the new system cannot.

**Recommended, and not performed:** consider whether production should have these
CASCADEs narrowed. It is a write to production, outside this mandate, and it is not
required for migration — but it is a standing risk to the asset being preserved.

---

## 7. The delta procedure

Once the baseline exists:

```
1. BASELINE      full dump + high-water mark H0, recorded in the same transaction
2. REHEARSE      restore → migrate into new staging → reconcile against control totals
3. (time passes; production keeps changing)
4. FREEZE        cutover window opens; legacy writes stop or are drained
5. FINAL SNAP    second full dump + high-water mark H1
6. DELTA         for SAFE_BY_* tables:      rows where created_at > H0 or updated_at > H0
                 for REQUIRES_FINAL_SNAPSHOT: full re-extract, compare by PK
                 for wallets:                full re-extract as a point-in-time record
                 for deletes:                PK-set difference, baseline vs final
7. MIGRATE DELTA idempotently, same import_run_id discipline, on conflict do nothing
8. RECONCILE     control totals against H1, not against H0
9. GO LIVE
```

**Step 8 is the one most often got wrong.** Reconciling the final state against the
*baseline* totals would show a mismatch for every legitimate new row. The comparison
must be against the final snapshot's own totals, with the delta accounting for the
difference between H0 and H1.

**Practical note:** because 24 hours of production produced zero new rows in the core
tables, the delta at cutover is likely to be small — tens of rows, not thousands. That
makes a **full re-extract-and-compare viable for every table**, which is strictly safer
than timestamp filtering. **Recommendation: if the delta window stays this quiet, skip
timestamp filtering entirely and re-extract everything.** The whole database is under
100 MB.

---

## 8. What would make this materially safer, and is not being done

Recorded because the brief asks for discovery, not changes to production:

| Option | Why it is not proposed |
|---|---|
| Add `updated_at` triggers to production | A write to production, and it changes application behaviour |
| Add an audit/CDC table | Same, plus ongoing load |
| Enable logical replication to the new project | The cleanest real answer to "production keeps changing", and worth considering for the cutover milestone — but it requires a publication on production, which is a write |
| Narrow the CASCADE FKs | A write to production; see §6 |

**Logical replication is the option worth revisiting when cutover is planned.** It would
turn the delta problem from "diff two snapshots" into "stream continuously", and it is
the standard answer for a live cutover. It is out of scope here only because it requires
modifying production.
