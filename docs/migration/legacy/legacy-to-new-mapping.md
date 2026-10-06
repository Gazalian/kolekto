# Legacy → new mapping

**Source:** `busfgcmbndleljklrcbd` (legacy production), verified 2026-09-26
**Target:** the new Kolekto schema, 79 migrations, verified against the live local
database
**Status:** mapping only. **No migration code has been written.**

Every legacy table appears exactly once. Under
[F-M3 zero data loss](migration-data-loss-policy.md) there is no "not migrated"
row: a table with no operational destination gets a preservation destination.

Legend for **Status**: `OPERATIONAL` becomes live new-system data ·
`HISTORICAL` is preserved, read-only, and never financial truth ·
`OVERFLOW` has no new-schema shape and is preserved verbatim.

---

## 1. The transformation that dominates everything: there is no community

Legacy `collections.user_id → auth.users`. New `collections.community_id` is
`not null` and references `communities`.

So before a single collection can land, a community must exist for each legacy
organizer. Two candidate strategies, and **this is a founder decision (F-L1)**:

| | Strategy | Consequence |
|---|---|---|
| **A** | One **personal community per organizer**, created by the migration | Every organizer keeps their own collections. 275 collections spread across however many distinct organizers. Matches the new system's own COM-01 behaviour (a new sign-up gets a personal community). **Recommended.** |
| B | One shared "Legacy" community holding all 275 | Simple, but every organizer would see every other organizer's collections. Breaks tenancy. **Not viable.** |
| C | Ask each organizer to create a community, then attach | Cleanest semantically, requires user action for 275 collections, and blocks migration on human response. |

Under A, `officer_terms` gains one `owner` row per organizer with
`start_reason = 'migration'` — a value that already exists in the enum.

---

## 2. Identity

| Legacy | → New | Transformation | Identity preservation | Status |
|---|---|---|---|---|
| `auth.users` (623) | `auth.users` | Direct | **UUID preserved — mandatory** | OPERATIONAL |
| `profiles` (622) | `public.users` | `full_name`, `email`, `avatar_url` map directly. `phone_number` → the member/contact layer, not `users`. | `profiles.id = auth.users.id = public.users.id` | OPERATIONAL |
| `profiles` extra columns — `address`, `date_of_birth`, `signup_ip`, `blocked_until`, `role`, `is_organizer`, `first_name`/`last_name`, `referred_by_ambassador_id`, `ambassador_referral_code` | `migration.legacy_profile.fields` | Preserved in the existing jsonb overflow | original `source_id` | HISTORICAL |
| Contributors (3,353 distinct emails in `contributions`) | `public.members`, status `unclaimed` | **Not** auth users. Only 388 contributions match a profile email. | `source_table='contributions'`, `source_id` | OPERATIONAL |
| `user_identity` (12) | **decision required** | NIN/BVN ciphertext. New `verification_records` is designed to hold a provider reference and result, not raw ID data. | — | **BLOCKED — legal** |
| `admin_users` (2), `admin_events` (71) | `staff_users` (designed, not built) + `migration.legacy_overflow` | Staff realm is ADR 0009 and unbuilt | — | HISTORICAL |

**The 1 auth user with no profile** must be preserved as an auth user with a
minimal `public.users` row; do not invent a name. Exception `E-ID-1`.

**The 13 profiles with no phone** are preserved as-is (F-M1). Do not invent a
number. They cannot become `active` members — see
[legacy-identity-inventory.md](legacy-identity-inventory.md).

---

## 3. Collections

| Legacy | → New | Transformation | Status |
|---|---|---|---|
| `collections` (275) | `public.collections` + `communities` + `officer_terms` | §1 above; `amount numeric` → `fixed_amount_kobo app.kobo` (`×100`, exact); `type`/`collection_type` → `category` + `amount_model` + `participation_mode`; `fee_bearer` → `fee_mode` | OPERATIONAL |
| `collections.price_tiers` jsonb (305 entries, 79 collections) | `public.collection_tiers` rows | **23 duplicate-name groups across 5 collections violate `unique (collection_id, lower(name))`.** 200 of 305 entries have no `id`. | OPERATIONAL + **exception** |
| `collections.contributions_fields` jsonb | `public.collection_fields` | Key format must satisfy `^[a-z][a-z0-9_]{0,38}$` | OPERATIONAL |
| `collections.story`, `story_images`, `social_links`, `banner_url`, `campaign_*`, `ticket_template_url`, `support_phone_number`, `rejection_reason`, `max_contributions`, `auto_close`, `is_open_ended`, `unique_id_enabled`, `allow_multiple_quantity`, `next_contributor_number` | `migration.legacy_collection.fields` | Some have new equivalents (story, banner); the rest are preserved | HISTORICAL |
| `collections.slug` | `collections.slug` + `public.legacy_links` (`kind='collection_slug'`) | Old URLs must keep resolving | OPERATIONAL |
| `contribution_code_counters` (53) | `collection_code_sequences` | Preserve `next_number` so codes never collide with reissued ones | OPERATIONAL |
| `collection_access_grants` / `_invites` / `_invite_items` (0) | `officer_terms` / `invite_links` | Empty, but the shape must still have a destination | OVERFLOW |
| `collection_transfer_requests` (0) | `migration.legacy_overflow` | No new equivalent | OVERFLOW |

`fee_bearer` maps cleanly: `contributor` (204) → `contributor_pays`,
`organizer` (71) → `community_absorbs`.

Type mapping and its 26 disagreements are in
[legacy-collection-model.md](legacy-collection-model.md).

---

## 4. Financial — nothing becomes live financial truth

**The governing rule: the import posts zero ledger journals and zero ledger
entries.** Legacy money is history. The new ledger starts empty and every entry in
it describes something that happened after it was built (D-23).

| Legacy | → New | Transformation | Status |
|---|---|---|---|
| `contributions` (5,576) | `migration.legacy_contribution.fields` | Full row preserved as jsonb. `amount`, `gross_amount`, `status`, timestamps, `payment_reference`, `line_index`, `contributor_information` all retained verbatim. Status kept as the legacy word, **never** mapped onto a new enum. | HISTORICAL |
| `deposits` **with** a collection (4,884) | `migration.legacy_deposit.fields` | Full row preserved | HISTORICAL |
| `deposits` **without** a collection (1,317, incl. 923 success = ₦19,799,220) | `migration.unattributed_payments` | Typed columns; the table **has no `collection_id` column**, which is what makes a future backfill impossible | HISTORICAL, **never attributed** |
| `withdrawals` (292) | **`migration.legacy_withdrawal`** — to be created (F-M2) | Immutable historical record. Design in [legacy-withdrawal-model.md](legacy-withdrawal-model.md) | HISTORICAL |
| `wallets` (245) | `migration.legacy_overflow` (or a dedicated `legacy_wallet`) | **Preserved as history. Never an opening balance.** The ₦3.59 drift is a property of this cache. | HISTORICAL, **never a balance** |
| `wallets_backup_20260805` (240) | `migration.legacy_overflow` | Forensic snapshot from the 2026-08-05 incident | HISTORICAL |
| `pending_payment_context` (797) | `migration.legacy_overflow` | The legacy payment state machine. Closest new analogue is `payment_attempts` + `financial_events`, neither of which should be populated from history. States: `initialized`, `completed`, `failed`, `reconciled`. | HISTORICAL |
| `payment_recovery_log` (30,242) | `migration.legacy_overflow` | Largest table in the database. Operational recovery attempts, incl. `selected_tier_id` | HISTORICAL |
| `payment_admin_actions` (220) | `migration.legacy_overflow` | Staff financial interventions — audit value | HISTORICAL |
| `settlement_runs` (56) | `migration.legacy_overflow` | Nightly job audit | HISTORICAL |
| `payment_reference_backfill_snapshot_20260811` (3,324) | `migration.legacy_overflow` | Forensic snapshot | HISTORICAL |
| `duplicate_void_snapshot_20260812` (12) | `migration.legacy_overflow` | Forensic snapshot; relates to the 14 `duplicate_voided` contributions | HISTORICAL |
| `payout_accounts` (26) | `withdrawal_accounts` (designed, not built) + overflow | Encrypted account number; **decryption key must be located first** | **BLOCKED** |
| `transfer_recipients` (52) | `migration.legacy_overflow` | **Plaintext** account numbers — do not carry the plaintext form forward | HISTORICAL, redact |

### Amount conversion

Every monetary column converts with `round(v * 100)::bigint`. Verified exact: no
value in the database exceeds 2 decimal places and none is negative. There is no
rounding policy to decide.

---

## 5. Subsystems with no new-schema equivalent

All get `migration.legacy_overflow` unless the founder decides the feature is
being rebuilt. Each retains `source_table`, `source_id`, full row jsonb, and
`import_run_id`.

| Legacy | Rows | Status | Note |
|---|---|---|---|
| Ambassador programme (6 tables) | 2 | OVERFLOW | `ambassador_profiles` carries `pin_hash` — a credential; **do not migrate the hash** |
| `campaigns`, `campaign_donations`, `campaign_images` | 2 | OVERFLOW | A **parallel fundraising entity**, distinct from `collections`. Needs a ruling on whether it becomes a collection (F-L2) |
| `campuses`, `students` | 47 | OVERFLOW | Campus directory |
| Email campaign engine (8 tables) | 4,839 | OVERFLOW | 4,710 recipients is the bulk |
| `notifications` (172) | 172 | OVERFLOW | New `notifications` is designed, not built |
| `push_subscriptions`, `push_notification_events` | 186 | OVERFLOW | Subscriptions contain browser endpoint keys — treat as secrets |
| KYC (5 tables) | 174 | OVERFLOW + **legal** | Pairs with `user_identity` |
| `password_change_otps`, `password_reset_otps` | 6 | OVERFLOW | Supabase Auth owns this in the new system; OTPs are short-lived and arguably worthless, but zero data loss says preserve |

---

## 6. Provenance available today, and what is missing

| Field the brief asks for | Available? |
|---|---|
| `source_table` | **yes** — on `collections`, `members`, and every `migration.legacy_*` table |
| `source_id` | **yes** |
| `import_run_id` | **yes** → `migration.import_runs` |
| `imported_at` | **yes** |
| `is_imported` | **yes**, with a `CHECK` making provenance mandatory iff imported |
| `source_system` | **yes** on `collections`/`members` |
| **`source_project`** | **MISSING** — no column records *which Supabase project* a row came from |
| `source_schema` | **MISSING** — implied by `source_table`, not stored |

**Recommendation E-P1:** add `source_project` to `migration.import_runs` rather
than to every row. One column on the run identifies the project for everything
that run imported, and it distinguishes a legacy-test rehearsal from a
legacy-production run — which matters precisely because rehearsals will happen
against test data first. Additive, one migration. **Not implemented.**

---

## 7. Re-run safety: the idempotency key per entity

The migration must resume after stopping at, say, `contributions 4000/5576`
without duplicating anything.

| Entity | Idempotency key | Enforced today? |
|---|---|---|
| auth users | `id` (UUID preserved) | yes, primary key |
| `public.users` | `id` | yes |
| collections | `(source_table, source_id) where is_imported` | **yes**, partial unique index |
| members | `(source_table, source_id) where is_imported` | **yes**, partial unique index |
| `legacy_collection` / `_profile` / `_deposit` / `_contribution` | `(source_table, source_id)` | **yes**, unique |
| `unattributed_payments` | `(source_table, source_id)` | **yes**, unique |
| **`legacy_withdrawal`** | `(source_table, source_id)` | **to be created with this constraint** |
| **`legacy_overflow`** | `(source_table, source_id)` | **to be created with this constraint** |
| collection tiers | `(collection_id, lower(name))` | unique — **and this is the constraint the 5 duplicate-name collections violate** |
| `collection_code_sequences` | `collection_id` | yes |

The pattern throughout is `insert … on conflict (source_table, source_id) do
nothing`, which is an enforced guarantee rather than an assumption about the
pipeline, because the partial unique indexes already exist.

---

## 8. What is blocked

| # | Blocker | Class |
|---|---|---|
| F-L1 | Community strategy for 275 collections | **FOUNDER** |
| F-L2 | Are legacy `campaigns` a collection, or overflow only? | **FOUNDER** |
| F-L3 | `type` vs `collection_type` — which is authoritative, and the 3 ambiguous rows | **FOUNDER** |
| F-L4 | The 5 collections with duplicate tier names | **FOUNDER** (rename, or relax the new constraint) |
| F-L5 | Withdrawal `approved` vs `success` semantics | **FOUNDER** |
| E-P1 | Add `source_project` to `import_runs` | ENGINEERING |
| E-W1 | Create `migration.legacy_withdrawal` | ENGINEERING (F-M2 approved) |
| E-O1 | Create `migration.legacy_overflow` | ENGINEERING (awaiting instruction) |
| L-1 | `user_identity` NIN/BVN — may it be migrated at all? | **LEGAL** |
| L-2 | KYC document retention | **LEGAL** |
| E-K1 | Locate decryption keys for `payout_accounts` | ENGINEERING |
