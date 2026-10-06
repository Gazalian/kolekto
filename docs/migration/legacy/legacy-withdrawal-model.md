# Legacy withdrawal model, and the design for `migration.legacy_withdrawal`

**Source:** `busfgcmbndleljklrcbd`, 292 withdrawals, ₦46,682,872.80 total
**Founder decision F-M2:** add legacy withdrawal preservation. **Approved.**
**Status:** design only. **No table was created and no migration was written.**

---

## 1. The legacy shape

`public.withdrawals`, 11 columns:

| Column | Type | Note |
|---|---|---|
| `id` | uuid | |
| `user_id` | uuid | the organizer; 0 orphans |
| `collection_id` | uuid | **0 nulls, 0 orphans** — withdrawals are already collection-level |
| `wallet_id` | uuid | points at the cache |
| `amount` | **numeric** | naira; `round(×100)` is exact |
| `status` | varchar | see §2 |
| `destination_account` | jsonb | bank details — **sensitive** |
| `paystack_transfer_code` | varchar | present on all 292 |
| `paystack_recipient_code` | varchar | present on all 292 |
| `created_at`, `updated_at` | timestamptz | |

**A genuinely good finding:** legacy withdrawals are already attributed to a single
collection, with no nulls and no orphans. The new architecture's collection-level
withdrawal model (ADR 0015, D-03) is therefore *consistent with history* rather
than a departure from it. There is no cross-collection allocation to unwind.

What legacy has that the new model separates: **there is no payout entity.** A
withdrawal and its execution are one row. The new design splits them, because one
withdrawal may need several payout attempts. History cannot be decomposed into
attempts after the fact — it must be preserved as the single row it is.

Also absent: any approval audit. There is no `approved_by`, no `approved_at`, no
second-approver record. `payment_admin_actions` (220 rows) may carry some of this
externally, but not linked to withdrawals by FK.

---

## 2. The status vocabulary changed, and it is not a workflow

| Status | Rows | Total (₦) | Date range | Transfer code | Never updated |
|---|---|---|---|---|---|
| `approved` | **239** | 41,653,495.80 | **2025-12-19 → 2026-09-17** | 239/239 | 139 |
| `success` | 43 | 4,550,917.00 | **2025-06-07 → 2025-12-08** | 43/43 | 43 |
| `rejected` | 10 | 478,460.00 | 2025-06-07 → 2026-08-02 | 10/10 | 10 |

**The two date ranges do not overlap.** `success` stops on 2025-12-08; `approved`
starts on 2025-12-19. Eleven days apart, and never both in use.

This is a **vocabulary change around mid-December 2025**, not a pipeline in which
`approved` precedes `success`. If `approved` meant "awaiting payout", there would
be 239 withdrawals worth ₦41.6m sitting unpaid — and the corroborating evidence
says otherwise: every one has a Paystack transfer code and a recipient code, and
`wallets.withdrawn` totals ₦46,204,412.80, which is the full ₦46,682,872.80 minus
exactly the ₦478,460.00 of `rejected`. **The wallet cache counts `approved` as
withdrawn.**

So the reading the data supports is: `approved` is the terminal paid state for
everything after 2025-12-19, and `success` is the terminal paid state before it.

**F-L5 — founder decision.** I am not encoding that reading without confirmation,
because mapping 239 withdrawals worth ₦41.6m to the wrong terminal state would
misstate ₦41.6m of history. The arithmetic above is strong evidence, not a ruling.

### Mapping, once F-L5 is answered

| Legacy | New withdrawal state (design) | Condition |
|---|---|---|
| `success` | `completed` | |
| `approved` | `completed` | **if F-L5 confirms** |
| `approved` | `approved` | if F-L5 says it means awaiting payout |
| `rejected` | `rejected` | |

Note the new machine has no `reversed` state yet (M8.2 finding A3/F3), and none of
the 292 legacy rows needs one.

---

## 3. Proposed `migration.legacy_withdrawal`

Follows the existing overflow pattern exactly — `legacy_deposit` and
`legacy_contribution` are the precedent — with typed columns for the figures that
must be reconcilable and jsonb for everything else.

```sql
create table migration.legacy_withdrawal (
  id                       uuid primary key default app.uuid_generate_v7(),

  -- Provenance, matching every other migration.legacy_* table.
  source_table             text        not null default 'withdrawals',
  source_id                uuid        not null,
  import_run_id            uuid        not null
                           references migration.import_runs (id) on delete restrict,
  imported_at              timestamptz not null default now(),

  -- Typed, because these are the figures a reconciliation compares.
  -- Integer kobo: round(legacy_naira * 100), exact for all 292 rows.
  amount_kobo              app.kobo    not null,
  original_status          text        not null,   -- verbatim: approved|success|rejected
  original_created_at      timestamptz,
  original_updated_at      timestamptz,

  -- Attribution. Nullable FKs so a withdrawal is never REFUSED for pointing at a
  -- collection that has not been imported yet; the legacy ids below are the
  -- durable record either way.
  collection_id            uuid references public.collections (id) on delete restrict,
  legacy_collection_id     uuid        not null,
  legacy_user_id           uuid        not null,
  legacy_wallet_id         uuid,

  -- Provider references, preserved so a legacy transfer stays traceable.
  provider                 text        not null default 'paystack',
  provider_transfer_code   text,
  provider_recipient_code  text,

  -- Everything else, verbatim. destination_account is REDACTED here — see §4.
  fields                   jsonb       not null,

  notes                    text,

  constraint legacy_withdrawal_amount_not_negative check (amount_kobo >= 0),
  constraint legacy_withdrawal_fields_is_object    check (jsonb_typeof(fields) = 'object')
);

create unique index legacy_withdrawal_source_key
  on migration.legacy_withdrawal (source_table, source_id);
create index legacy_withdrawal_collection_idx
  on migration.legacy_withdrawal (legacy_collection_id);
```

Plus, to match the rest of the migration schema:

- `alter table … enable row level security;` **and** `force row level security;`
- a `using (false)` policy — no client role reads it (it holds bank details)
- `revoke all … from anon, authenticated;`
- append-only via `app.block_row_mutation()`, the existing generic guard already
  attached to `unattributed_payments`

**Design notes, and why each choice:**

1. **`original_status` is `text`, not an enum.** A legacy status is preserved
   verbatim and never mapped onto a new enum that means something subtly
   different. `legacy_deposit` and `unattributed_payments` do the same.
2. **`legacy_collection_id` is `not null` and separate from `collection_id`.** The
   legacy id is the durable fact; the FK is a convenience that may be null if the
   collection has not landed yet. Without the separate column, an import-ordering
   problem would become a data-loss problem.
3. **`amount_kobo` is typed, the rest is jsonb.** A reconciliation has to sum
   amounts; it does not have to sum anything else.
4. **Append-only.** A withdrawal that has already paid a bank is not editable
   history.
5. **No `payout` decomposition.** Legacy has no payout entity and inventing
   attempts would fabricate events that never happened.

---

## 4. `destination_account` contains bank details

All 292 rows carry a jsonb `destination_account`. It almost certainly includes an
account number, name and bank.

**Recommendation:** store it **redacted** in `fields` — bank name, bank code and
last four digits only — and keep the full value out of the new database entirely.
The new architecture has no reason to hold a historical payout destination: the
withdrawal already happened, and re-paying it is not a supported operation.

**This is a decision, not a default**, because it is the one place in this design
where a field is deliberately not carried across in full. It needs a founder and
counsel ruling (`L-3`). If full preservation is required, it must be encrypted at
rest like `payout_accounts.account_number_cipher`, not plaintext like
`transfer_recipients.account_number`.

Under zero data loss, "redacted" still means the source row remains intact in
legacy production, which is read-only and retained.

---

## 5. Control total for verification

After import, this must hold:

| Check | Expected |
|---|---|
| `count(*)` in `legacy_withdrawal` | **292** |
| `sum(amount_kobo)` | **4,668,287,280** (₦46,682,872.80) |
| rows by `original_status` | approved 239, success 43, rejected 10 |
| rows with a null `legacy_collection_id` | **0** |
| **ledger journals created** | **0** |
| **ledger entries created** | **0** |

No withdrawal may silently disappear: 292 in, 292 preserved.
