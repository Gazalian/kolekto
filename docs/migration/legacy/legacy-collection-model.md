# Legacy collection model

**Source:** `busfgcmbndleljklrcbd`, 275 collections, verified 2026-09-26
**Rule for this document:** describe the legacy data as it is. **Do not fix it.**

---

## 1. Shape

`public.collections`, 40 columns, no `deleted_at`, no `archived_at`, no
`community_id`. Ownership is `user_id uuid not null → auth.users`.

Money columns are **`numeric`**: `amount` (not null), `target_amount`,
`min_contribution`. There is no kobo domain and no integer money anywhere.

Four jsonb columns carry structure the new schema models as rows:
`price_tiers`, `contributions_fields`, `story`, `story_images`, `social_links`.

---

## 2. The `type` vs `collection_type` hazard, measured

Both columns exist. `type varchar not null`; `collection_type text null`.

| `type` | `collection_type` | Collections | Deleted | Have tiers |
|---|---|---|---|---|
| fixed | fixed | 151 | 5 | 0 |
| tiered | tiered | 74 | 5 | 74 |
| flat | fixed | **20** | 1 | 0 |
| fundraising | fundraising | 13 | 0 | 0 |
| open_pool | open_pool | 11 | 1 | 0 |
| tiered | **ticket** | **3** | 0 | 3 |
| tiered | **fixed** | **2** | 0 | **2** |
| flat | **ticket** | **1** | 0 | **0** |

**249 rows agree. 26 disagree.** They split into three cases:

**Benign (20 rows).** `flat` → `fixed`. `flat` is the older name; no tiers exist
on any of them. A rename, not a conflict.

**Informative (3 rows).** `tiered` → `ticket`. All three have tiers.
`collection_type` is the more specific column — it is the only one with a `ticket`
value at all — and `type` records the pricing mechanism. Reading
`collection_type` as authoritative and `type` as the mechanism explains these
three cleanly.

**Genuinely contradictory (3 rows).** Requires a ruling:

- **2 rows: `type='tiered'`, `collection_type='fixed'`, and they *have* real price
  tiers.** One column says fixed-price; the data says tiered. Migrating them as
  `fixed` would discard their tiers; migrating as `tiered` contradicts
  `collection_type`.
- **1 row: `type='flat'`, `collection_type='ticket'`, and it has *no* tiers.** A
  ticketed collection with nothing to sell.

**F-L3 — founder decision.** My reading of the evidence is that `collection_type`
is authoritative for *category* and `type` for *amount model*, which resolves 23
of the 26 and leaves these 3 for individual inspection. I am not applying that
reading without a ruling.

### Proposed mapping to the new schema

| Legacy | New `category` | New `amount_model` | New `participation_mode` |
|---|---|---|---|
| fixed / flat | `dues` or `contribution` | `fixed` | depends on audience |
| tiered | `event` or `contribution` | `tiers` | |
| ticket | `event` | `tiers` | `open` |
| fundraising | `fundraiser` | `open_amount` | `open` |
| open_pool | `contribution` | `open_amount` | `open` |

`category` cannot be derived mechanically for `fixed`/`tiered` — legacy has no
category concept. Either default everything to `contribution` and let organizers
re-categorise, or infer from the title. **Defaulting is safer and is what I
recommend**; inference from free text would silently mislabel.

---

## 3. Status, and the 12 soft-deleted collections

| Status | Count |
|---|---|
| active | 237 |
| closed | 21 |
| **deleted** | **12** |
| paused | 4 |
| rejected | 1 |

`deleted` is a **soft delete in a varchar**. Under zero data loss all 12 must be
preserved. The new schema's nearest equivalent is `status='archived'` with
`archived_at` set — and `collections_archived_has_timestamp` **requires** the
timestamp. Legacy has no deletion timestamp, so `updated_at` is the only available
proxy.

**Exception `E-COL-1`:** using `updated_at` as `archived_at` is an inference. The
alternative is a new status value. Founder/engineering decision; do not silently
use `now()`, which would make every legacy deletion look like migration day.

`paused` (4) and `rejected` (1) have no new equivalent either. `rejected` also
carries `rejection_reason`, which must be preserved.

---

## 4. Tiers — the sharpest hazard

305 tier entries across 79 collections. Keys observed across all entries:
`id`, `name`, `price`, `prefix`, `description`, `quantity`, `remaining_quantity`,
`sold_quantity`.

Two measured problems:

**23 duplicate-name groups across 5 collections.** The new schema enforces
`unique (collection_id, lower(name))` — ADR 0010, added precisely because the
legacy `.find()` on id-or-name collapsed two same-named tiers onto one price and
caused a real payment incident. **Those 5 collections cannot be migrated as-is.**
Options: rename the duplicates during migration (changes what contributors saw),
or relax the constraint for imported rows (weakens the rule that exists because of
this data). **F-L4 — founder decision.** The legacy team already built
`v_collections_with_duplicate_tier_names`, so this was known.

**200 of 305 tier entries lack a usable legacy id** (the `id` key is either missing or its value is empty).
Verified 2026-09-28 against the D2 restore — see [MIGRATION-DECISION-EVIDENCE.md §15](MIGRATION-DECISION-EVIDENCE.md).
The new schema makes a tier a row with a
UUID and requires `tier_id` as a real FK on anything that references it. Without a
stable legacy id, matching a historical payment to its tier must fall back to name
or price — which is exactly the failure mode ADR 0010 exists to prevent. For
history this is tolerable (the tier snapshot is preserved in the overflow jsonb);
for anything that must be *linked*, it is not.

`remaining_quantity` and `sold_quantity` are mutable counters inside jsonb. The new
schema derives sold quantity from contributions and keeps `quantity_limit` as
configuration. The legacy counters should be preserved as history, not trusted.

---

## 5. Contributor codes

`contributions.contributor_unique_code` is set on **2,494 of 5,576** contributions.
`contribution_code_counters` (53 rows) holds `(collection_id, prefix, next_number)`.

The new `collection_code_sequences` must be seeded with legacy `next_number` so a
reissued code can never collide with a historical one. A contributor holding
"DUES-0042" from 2026 must not meet a new "DUES-0042".

Codes also need `legacy_links` entries (`kind='contributor_code'`) so an old code
still resolves.

---

## 6. Fields not represented in the new operational schema

Preserved in `migration.legacy_collection.fields`:
`max_contributions`, `support_phone_number`, `rejection_reason`,
`unique_id_enabled`, `ticket_mode`, `allow_multiple_quantity`, `is_open_ended`,
`auto_close`, `campaign_category`, `campaign_keywords`, `campaign_country`,
`campaign_summary`, `social_links`, `ticket_template_url`, `currency_symbol`,
`total_contributions`, `next_contributor_number`.

`total_contributions` and `next_contributor_number` are **denormalised counters**.
The new schema derives the first and sequences the second. Preserve, do not trust.

---

## 7. Positive findings

- **Every collection has a valid organizer.** 0 collections point at a missing
  profile or a missing auth user. The "collections without valid organizers"
  hazard does not exist in this data.
- **Every collection is NGN.** 275/275. No multi-currency problem.
- **No collection has a null `collection_type`.** All 275 are populated.
- 30 collections have no wallet row — consistent with never having taken a
  payment, and harmless because wallets are a cache.
