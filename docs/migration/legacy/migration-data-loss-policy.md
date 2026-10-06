# Migration data-loss policy

**Founder decision F-M3: ZERO DATA LOSS.** Every legacy record must have an
explicit destination or preservation mechanism.

This document is the rule. [legacy-to-new-mapping.md](legacy-to-new-mapping.md) is
the per-table application of it, and
[legacy-migration-exceptions.md](legacy-migration-exceptions.md) is the list of
things that do not fit.

---

## 1. The rule

> No legacy row may be dropped, and no legacy field may be discarded, because the
> new schema has no place for it. If the new operational schema cannot represent
> something, it is **preserved verbatim** somewhere that can.

The four permitted destinations, and nothing else:

| # | Destination | For |
|---|---|---|
| 1 | A new **operational** table | Data the new product actively uses |
| 2 | A new **historical/imported** table (`is_imported = true`) | Records the new product shows but never recomputes |
| 3 | A dedicated **`migration.legacy_*`** table | A known legacy entity with its own shape |
| 4 | **`migration.legacy_overflow`** | A shape nothing else fits |

**Forbidden as outcomes:** "ignored", "not needed", "not migrated", "unsupported
therefore dropped", "superseded", "obsolete". Each of those is a decision to lose
data wearing a technical word.

---

## 2. What "preserved" has to mean

Preservation is not a row count. Four properties, all required:

1. **The original identifier survives.** `source_table` + `source_id`, so a legacy
   row can be found again from a legacy reference.
2. **Provenance survives.** `import_run_id`, `imported_at`, `is_imported`, and
   (once **E-P1** lands) `source_project`, so nobody has to guess which system or
   which run produced a row.
3. **The original values survive unreinterpreted.** A legacy `status` is stored as
   the legacy word. Mapping it onto a new enum that means something subtly
   different is a form of loss, and it is the harder kind to detect because the row
   is still there.
4. **It is immutable.** An imported row cannot be edited, so a later run or a
   well-meaning fix cannot quietly change what history said.

All four are already enforced for `collections` and `members`, and by the existing
`migration.legacy_*` tables. The gaps are E-P1 (`source_project`) and the two
tables that do not exist yet (`legacy_withdrawal`, `legacy_overflow`).

---

## 3. What is explicitly NOT preserved, and why that is not data loss

Three narrow categories. Each is a deliberate exclusion of a *copy*, while the
source row remains intact in legacy production, which is read-only and retained.

| Excluded | Reason |
|---|---|
| **Password hashes and credential material** — `auth.users` secrets, `ambassador_profiles.pin_hash` | Copying a credential multiplies where it can leak. Supabase Auth carries its own users; a PIN hash for an unbuilt subsystem has no purpose. |
| **Plaintext bank account numbers** — `transfer_recipients.account_number` | Carrying plaintext account numbers into a new system when the same data exists encrypted elsewhere would be a step backwards. Preserve redacted (bank, last 4). |
| **Full `withdrawals.destination_account`** | See [legacy-withdrawal-model.md](legacy-withdrawal-model.md) §4. Redacted preservation proposed, pending `L-3`. |

**This distinction matters and must not be stretched.** It applies only to
credentials and account numbers, and only because a redacted or omitted *copy*
leaves the original untouched. It is not a licence to skip anything inconvenient.

---

## 4. The hard financial rule

**Legacy money becomes history. It never becomes financial truth.**

| Legacy artefact | Destination | Never |
|---|---|---|
| `contributions` (5,576) | `migration.legacy_contribution` | a ledger entry |
| `deposits` (6,201) | `legacy_deposit` / `unattributed_payments` | a ledger entry |
| `withdrawals` (292) | `migration.legacy_withdrawal` | a ledger entry |
| **`wallets` (245)** | preserved as history | **an opening balance** |

The `wallets` table is the specific trap. It holds six mutable numbers per
collection and they look exactly like balances. They are a cache, rebuilt nightly
by `settlement_recompute_wallets` — and this baseline independently measured the
consequence: `wallets.net_payment` exceeds the sum of paid contributions by
**₦3.59**. A number that is ₦3.59 wrong, that no entry explains, must not be the
number the new ledger starts from.

**The import posts zero journals and zero entries.** That is asserted by
`supabase/tests/23_migration_fixtures.sql`, which imports a full fixture set and
checks all three counts are zero.

---

## 5. Aggregates are not preservation

Legacy carries several denormalised counters: `collections.total_contributions`,
`collections.next_contributor_number`, the wallet columns, and
`remaining_quantity`/`sold_quantity` inside tier jsonb.

**Preserve them as recorded history; do not trust them as current state.** The new
schema derives these. Where a counter must not collide with new activity —
`contribution_code_counters.next_number` is the case — seed the new sequence from
the legacy value so a reissued code can never duplicate a historical one.

---

## 6. Empty tables still need a destination

Thirteen legacy tables have zero rows today. They still need a decision, for two
reasons: production is live and could gain rows before the real snapshot, and a
shape with no destination is a gap in the plan whether or not it currently holds
data.

Their destination is `migration.legacy_overflow`, and if they are still empty at
snapshot time the migration records "0 rows preserved" rather than omitting them.

---

## 7. How compliance is proved

A migration run is not complete because the SQL finished. It is complete when the
report in [migration-runbook.md](migration-runbook.md) shows:

1. Source count and target count for **every one of the 53 tables**, reconciled.
2. Every exception assigned to a named category with an owner.
3. The three zeros: zero ledger journals, zero ledger entries, zero opening
   balances.
4. Auth UUID preservation: 623 in, 623 out, same identifiers.
5. An explicit statement of anything deliberately redacted, per §3.

A table missing from that report is a data-loss risk, not an omission from a
document.
