# Legacy production preservation gate — status

**Date:** 2026-09-27 · **Target:** `busfgcmbndleljklrcbd` (LIVE)
**Nothing in legacy production or legacy test was modified.** Every statement issued was a
`SELECT`, and `pg_dump` issues only `SELECT` under `ACCESS SHARE`.

> **Updated 2026-09-27 — the backup has since been executed and verified.** This document
> originally recorded the state *before* D1. Section A now reflects the artefact that
> exists. **The overall classification in section G is unchanged: DO NOT DISCONNECT.**

---

## A. Production preservation status

| Item | Status |
|---|---|
| Backup mechanism | **`pg_dump` 15.19** via the `postgres:15` container image — plan in [production-backup-plan.md](production-backup-plan.md) |
| **Backup executed?** | **YES — 2026-09-27** |
| Backup location | `Desktop/Kolekto-codebase/Kolekto-Preservation/2026-09-27-busfgcmbndleljklrcbd/` — outside every git repository, **but not yet encrypted and not yet copied off the machine** |
| Checksum | **5/5 SHA-256 verified twice** — `sha256sum -c` and independent recomputation |
| Backup timestamp | Dumps written 12:06–12:11 UTC |
| **High-water mark** | **AUTHORITATIVE: `2026-09-27 12:06:56.844896 UTC`**, `wrote_nothing: true`. All ten counts agree with the dump contents. Earlier reference capture: `2026-09-27 00:45:19.325890 UTC` — [delta strategy §3](live-production-delta-strategy.md) |
| **Backup verified?** | **YES — PASS WITH EXCEPTION.** All 20 control totals reproduce, including the ₦3.59 drift. Exception: `settlement_runs` 56 → 57 from the nightly job. Non-financial |
| **Restore executed?** | **NO** — D2 is a separate gate. Prerequisites in [backup plan §13.1](production-backup-plan.md) |
| **Restore verified?** | **NO** |

**The credential was supplied through discrete `PG*` environment variables, used once, and
cleared.** It was never written to a file, never printed, and never committed.

> **The artefact is currently one unencrypted copy on one machine.** Until it is encrypted
> and a second copy exists off that machine, the backup is itself a single point of failure.
> That final preservation step is the founder's to perform.

## B. Live delta strategy

Full analysis in
[live-production-delta-strategy.md](live-production-delta-strategy.md). All 53 tables
classified; **zero UNKNOWN**.

| Class | Tables |
|---|---|
| SAFE_BY_UPDATED_AT | 20 |
| SAFE_BY_CREATED_AT | 13 |
| IMMUTABLE_APPEND_ONLY | 4 |
| **REQUIRES_FINAL_SNAPSHOT** | **11** (8,266 rows) |
| REQUIRES_SPECIAL_HANDLING | 1 (`wallets`) |
| **SAFE_BY_MONOTONIC_ID** | **0** |

**Four findings drive the design.**

**Every `id` is UUID v4 — random, not ordered.** Verified on five core tables. So
ID-based delta tracking is unavailable *everywhere*; detection rests on timestamps and,
where those are absent, on primary-key set comparison.

**The payment path moved in June 2026.** `deposits` has taken no new row since
2026-06-16; `pending_payment_context` took over. So `deposits` (6,201 rows) needs no
insert-delta at all, the ₦19.8m unattributed set **cannot grow**, and
`pending_payment_context` is the delta-critical table.

**Eleven tables have neither `created_at` nor `updated_at`** and must be re-extracted
wholesale. They total 8,266 rows, dominated by `email_campaign_recipients` (4,710) and a
forensic snapshot (3,324) — none financially critical.

**Deletes are invisible to every timestamp strategy, and the FKs cascade.** Deleting one
collection would cascade-delete its contributions, wallet, withdrawals and code counter;
deleting one auth user would cascade their profile, payout accounts, identity and KYC.
The only defence is a retained baseline to diff primary-key sets against — **another
reason the backup is the gate.**

**Practical recommendation:** 24 hours of production produced **zero new rows** in the
core tables, and the whole database is under 100 MB. If the window stays this quiet,
**skip timestamp filtering and re-extract everything at cutover** — strictly safer than
filtering, and cheap.

## C. Structural preservation

Summarised in [legacy-structural-capture.md](legacy-structural-capture.md).

| Item | Status |
|---|---|
| Schema (columns, defaults, constraints, indexes) | **INVENTORIED, not captured** — needs `pg_dump --schema-only` (**D5 depends on D1**) |
| Functions (95, 20 definer) | Names, signatures, grants captured. **Bodies need the dump** |
| Triggers (9) | Names and tables captured. **Definitions need the dump** |
| Views (8, all definer, none anon-granted) | Names and security captured. **Definitions need the dump** |
| Policies (25 tables policed) | Counts captured. **Expressions need the dump** |
| Grants | **CAPTURED in full** |
| **Enums (2)** | **CAPTURED in full**, including the `Other`/`Others` sprawl |
| **Sequences (2)** | **CAPTURED in full.** `campuses` holds 46 rows with its sequence at 2 — **explicit ids must be preserved** |
| **FK actions** | **CAPTURED.** Ten financial CASCADEs found — see B |
| **Cron (2 jobs)** | **CAPTURED.** Job 5's command holds a secret; needs `--schema cron` in the dump |
| Storage | **INVENTORIED** — 6 buckets, 68 objects, 24.4 MB. Files not downloaded |
| Edge Functions | **13, all with git-tracked local source.** Deployed-vs-local diff still required |

**Honest limitation:** a schema cannot be faithfully reconstructed from prose. This
inventory is for planning; the dump is the preservation.

## D. Encryption and keys

**E-K1 is RESOLVED — not blocked.**

| Item | Finding |
|---|---|
| Mechanism | **AES-256-CBC**, Node `createCipheriv`, key = **SHA-256(passphrase)** |
| Key reference | **`ACCOUNT_ENCRYPTION_KEY`** |
| Location | `kolekto-be-old/.env` — present, non-empty. **Not** in Supabase Vault (0 secrets), **not** in any database function |
| Rotation slot | `ACCOUNT_ENCRYPTION_KEY_PREVIOUS` absent — no rotation has occurred |
| Affected | **26/26** payout accounts · **12/12** `user_identity` rows (nin + bvn) |
| Ciphertext migratable without the key? | **Yes** — `bytea` moves verbatim; `last4`/bank fields stay readable |
| Does the new system need plaintext? | **No, and it should not have it** |

> **The risk is availability, not exposure. The key exists in exactly one place: a
> git-ignored `.env` on one machine. Lose that machine and 38 records become permanently
> undecryptable.**

**D8 action: archive the key to a proper secret store before legacy access ends. Do NOT
rotate it** — rotating without re-encrypting first would destroy readability for ever.

### Secrets requiring attention — types and locations only, no values anywhere

| # | Type | Location | Severity | Action |
|---|---|---|---|---|
| 1 | Cron shared secret | `cron.job`, jobid 5, legacy production | **HIGH** | Rotate |
| 2 | Paystack **live** secret key | `kolekto-be-old/.env`, `.env.bak.pre-email-fix`, 2 diffs in git history | **HIGH** | Rotate with a deploy |
| 3 | `ACCOUNT_ENCRYPTION_KEY` | `kolekto-be-old/.env` only | **HIGH (availability)** | **Archive. Do not rotate** |
| 4 | Sample passphrase | `kolekto-be-old/.env.example` (tracked) — **verified different from the real key** | LOW | Replace with a placeholder |
| 5 | Edge Function secrets | Supabase project config, not the database | MEDIUM | Inventory names before access ends |

## E. Migration destination matrix

Full matrix in [migration-destination-matrix.md](migration-destination-matrix.md).

**53 of 53 tables accounted for.** 7 operational · 4 migration tables · 38 overflow ·
**0 explicitly-not-migrated** · **1 undecided** (`user_identity`, blocked on counsel).

## F. Cutover safety

| # | Item | Status | Evidence | Remaining action |
|---|---|---|---|---|
| **D1** | Full production backup | **DONE — VERIFIED** | 7 artefacts, 28,979,193 bytes, 5/5 checksums, all 20 control totals reproduce incl. the ₦3.59 drift | **Encrypt and copy off the machine** — not yet done |
| **D2** | Verified restore | **NOT DONE** | Not attempted | Restore into disposable local PG **15**. **Prerequisites now known — see [backup plan §13.1](production-backup-plan.md): 5 extensions unavailable, 4 roles must be pre-created, psql ≥ 15.14** |
| **D3** | High-water mark | **DONE — AUTHORITATIVE** | `2026-09-27 12:06:56.844896 UTC`, `wrote_nothing: true`, all ten counts agree with the dump contents | None |
| **D4** | Delta strategy | **DONE** | All 53 classified, 0 UNKNOWN | Founder to accept the re-extract-everything recommendation |
| **D5** | Full structural capture | **DONE** | `legacy-prod-schema.sql`: 96 function bodies, 19 trigger definitions, 9 view definitions, 80 policy expressions, 883 grants, 78 RLS enables, 14 enums, 3 sequences, 213 constraints, 80 FKs | None — **closed by D1** |
| **D6** | Storage inventory | **DONE (inventory)** | 6 buckets, 68 objects, 24.4 MB | Object backup needs **B5** — 53 identity documents |
| **D7** | Edge Function preservation | **MOSTLY DONE** | All 13 slugs git-tracked in `kolekto-fe-old` | **Download and diff deployed vs local** — evidence of past staleness |
| **D8** | Payout encryption key | **IDENTIFIED, NOT ARCHIVED** | AES-256-CBC, `ACCOUNT_ENCRYPTION_KEY` in one `.env` | **Archive to a secret store** |
| **D9** | Destination completeness | **DONE** | 53/53, 1 undecided on counsel | Close L-1 |
| **D10** | New staging | **NOT CREATED** | Per Phase 14 | Separate controlled phase |
| **D11** | New production | **NOT CREATED** | Per Phase 14 | Separate controlled phase |

**Seven of eleven complete. D1 is done and verified, and it closed D5 with it. D2 is now
the keystone — and it is unblocked, with its prerequisites known in advance.**

## G. Final classification

# DO NOT DISCONNECT

**Updated 2026-09-27 after D1.** Two of the four original preconditions are now met. Three
remain unmet, so the classification stands.

| # | Precondition | State |
|---|---|---|
| 1 | Full production backup exists (D1) | **MET** — taken and verified 2026-09-27 |
| 2 | A restore has been verified (D2) | **NOT MET** — not attempted |
| 3 | Structural capture is complete (D5) | **MET** — closed by D1 |
| 4 | Storage objects backed up (D6), encryption key archived (D8) | **NOT MET** |
| 5 | The backup is itself safely preserved | **NOT MET** — one unencrypted copy on one machine |

**The decisive fact has changed, but not enough.** Legacy production is no longer the
*only* copy of those 53,742 rows — 623 identities, 275 collections, 5,576 contributions,
6,201 deposits, 292 withdrawals and ₦46.7 million of financial history. There is now a
second copy, and it is verified faithful to the kobo.

**But that second copy is one unencrypted directory on one laptop, and no restore has ever
been proven to work from it.** A backup nobody has restored is a hypothesis, not a
safeguard. Until D2 passes and the artefact is encrypted and duplicated off that machine,
disconnecting would still risk the whole estate.

Two things established earlier make disconnection *more* dangerous than it looks, and
neither is resolved by D1:

- **Ten foreign keys cascade.** A single `DELETE` on one collection or one auth user
  destroys dependent financial and identity history. Without a retained backup, such a
  deletion is both irreversible and undetectable.
- **The encryption key exists in exactly one place.** Losing it makes 26 bank-account
  ciphertexts and 12 NIN/BVN records permanently unreadable — and that loss would be
  silent until someone needed them.

### The shortest path to `SAFE TO DISCONNECT`

| Order | Action | Gate |
|---|---|---|
| ~~1~~ | ~~Answer **B1–B4** and run the dump~~ | **D1 — DONE 2026-09-27, verified. Closed D5 with it** |
| 1 | **Encrypt the artefact and put a second copy off the machine** | Preservation — the backup is currently a single point of failure |
| 2 | Restore into a disposable local PG 15 and compare control totals. **Prerequisites in [backup plan §13.1](production-backup-plan.md)** | D2 |
| 3 | **Archive `ACCOUNT_ENCRYPTION_KEY` to a secret store. Do NOT rotate it** | D8 |
| 4 | Download all 13 Edge Functions and diff against `kolekto-fe-old` | D7 |
| 5 | Decide **B5**, then back up Storage (53 identity documents need counsel) | D6, L-2 |
| 6 | Close **L-1** with counsel | D9 |

Steps 1–4 are days of work at most. **Steps 1 and 3 cost minutes each and remove the two
standing single-points-of-failure — the unencrypted lone backup and the lone copy of the
encryption key. Do those first.** Steps 5 and 6 need counsel and are the long poles.

D10 and D11 are deliberately excluded — Phase 14 defers new-project provisioning to its
own controlled phase, and disconnection should not wait on them.

---

## Founder decisions applied in this work

Recorded so nothing is re-litigated: **F-M1** every authenticated user retained, phone
from `profiles.phone_number`, none invented · **F-M2** `migration.legacy_withdrawal` is
the withdrawal destination · **F-M3** zero data loss · **F-L1** one personal community
per production organizer · **F-L3** `collection_type` authoritative, `type` preserved as
provenance · **F-L5** `approved` and `success` are both terminal paid states, originals
preserved · **F-L6** the test workspace prototype is not production customer history.

The ₦19.8m unattributed matter and the wallet/withdrawal anomalies were **not reopened**.
They are preserved as historical truth, and today's finding that `deposits` stopped
receiving rows in June 2026 means the unattributed set is now closed by arithmetic as
well as by policy.
