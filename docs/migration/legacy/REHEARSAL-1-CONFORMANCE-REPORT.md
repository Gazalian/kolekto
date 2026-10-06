# Rehearsal #1 — legacy collection conformance report

**Date:** 2026-09-28 · **Mode: READ-ONLY** · **Source:** the verified D2 restore
(`kolekto-legacy-restore`, database `legacy_restore`) of the D1 backup of legacy
production. **No legacy Supabase project was queried. Nothing was written, anywhere.**
The session ran with `default_transaction_read_only = on`, so a write would have
been refused by Postgres, not just avoided.

**Nothing was transformed.** Every finding names a *proposed* transformation category;
none is applied. This report turns the open founder decisions into specific rows.

## 1. Summary

| | |
|---|---|
| Legacy collections measured | **275** |
| Legacy tier entries measured | **305** (in 79 collections) |
| Finding rows | **128** |
| Collections with at least one constraint finding (C*, T*) | **45** |
| — needing a **decision** | **23** |
| — **mechanical only** (C06, resolved by the documented mapping) | **22** |
| Collections with **no** constraint finding | **230** |

| Code | Finding | Rows | Collections | Kind |
|---|---|---|---|---|
| C01 | Title too long or short for `name` | 1 | 1 | decision |
| C04 | Status with no equivalent — `rejected` | 1 | 1 | decision |
| C05 | Deleted collections — archival timestamp | 12 | 12 | decision |
| C06 | Open-amount collections carrying a legacy amount | 23 | 23 | mechanical |
| T03 | Duplicate tier names — F-L4 | 23 | 5 | decision |
| T04 | Tier code prefix format | 2 | 1 | decision |
| T05 | Tier code prefix duplicated within a collection | 2 | 2 | decision |
| T06 | Tier quantity of zero | 1 | 1 | decision |
| A01 | Fixed price of zero | 2 | 2 | advisory |
| A02 | Fixed collections holding price tiers (F-L3 consequence) | 2 | 2 | advisory |
| A03 | Tier-model collection with no tiers | 1 | 1 | advisory |
| A04 | Tiers with no stable legacy id | 58 | 58 | advisory |

**Kinds.** *decision* — an imported row would fail a destination constraint unless
someone decides how to transform it. *mechanical* — the documented mapping already
resolves it without losing anything; listed so the importer is written to do it.
*advisory* — no constraint fails, but the imported row would mean something
surprising.

### Rules that every legacy collection already satisfies

Each of these was measured and returned **zero** findings. Zero results were not
taken on trust — each rule was checked against a positive control:

| Rule | Result | Control |
|---|---|---|
| `collections_slug_format` | **275 / 275 pass** | the same regex rejects `Bad_Slug` |
| `collections_community_slug_key` (no organizer reuses a slug) | 0 duplicates | — |
| `collections_amounts_not_negative` | 0 negative amount, target or minimum | — |
| `collections_description_length` (≤ 2000) | 0 — longest is 914 | — |
| `collections_story_*_length` (≤ 2000) | 0 — one collection has a story | — |
| Monetary precision (≤ 2 decimals, so kobo is exact) | 0 collections, 0 tiers | — |
| `fee_mode` mapping | all 275 are `contributor` (204) or `organizer` (71) | — |
| Currency | all 275 are NGN | — |
| `collection_tiers_name_length` (1..60) | 0 | — |
| `collection_tiers_price_positive` | 0 — prices run ₦102 to ₦20,000,000 | — |
| Organizer exists | 0 collections without their auth user | — |

## 2. The mapping these results assume

Legacy has no `name`, `category`, `audience` or `participation` columns, so
"does this row conform?" only has meaning under a mapping. These are the mappings
already documented in [legacy-to-new-mapping.md](legacy-to-new-mapping.md) and
[legacy-collection-model.md](legacy-collection-model.md), with founder decision F-L3
applied. **A different mapping gives different results.**

| # | Destination | From |
|---|---|---|
| M1 | `name` | `title` |
| M2 | `slug` | `slug`, verbatim |
| M3 | `status` | active→active, closed→closed, paused→paused, deleted→archived; **rejected→none** |
| M4 | `amount_model` | by `collection_type` (F-L3): fixed→fixed; tiered, ticket→tiers; fundraising, open_pool→open_amount |
| M5 | `fixed_amount_kobo` | `round(amount × 100)` for fixed only; null otherwise |
| M6 | `target_amount_kobo`, `min_amount_kobo` | `round(× 100)` |
| M7 | `participation_mode` / `audience_mode` | open / public for every legacy collection — legacy collections were public links. Satisfies `collections_audience_matches_participation` by construction; **the choice itself is unconfirmed** |
| M8 | `description`, `story_what/why/impact` | verbatim |
| M9 | `fee_mode` | contributor→contributor_pays, organizer→community_absorbs |
| M10 | `deadline_at`, `event_starts_at` | `deadline`, `event_date` |
| M11 | `published_at` / `published_by` | set together for every non-draft row, satisfying `collections_published_consistently` by construction |
| M12 | `community_id`, `created_by` | the organizer's personal community; `user_id` |
| M13 | `collection_tiers` rows | only for amount_model **tiers**; `name`, `price × 100`, `prefix`→`code_prefix`, `quantity`→`quantity_limit` |

Rules that cannot fail under this mapping and so are not reported: per-member and
recurring rules (no legacy collection maps to either), installments (no partial
payments — ADR/decision), suggested amounts and venue (legacy has neither),
`draft_step`, and provenance (set by the importer).

## 3. Findings

### C01 — Title too long or short for `name`

| Source collection id | Source slug | Source issue | Destination constraint | Proposed transformation category |
|---|---|---|---|---|
| `40e4cc9e-72c8-4088-aaf5-ce25ebc1dbd1` | `mr-40e4cc9e` | title is 2 characters | `collections_name_length (3..80)` | FOUNDER: shorten title (full title kept in legacy_collection) |

### C04 — Status with no equivalent — `rejected`

| Source collection id | Source slug | Source issue | Destination constraint | Proposed transformation category |
|---|---|---|---|---|
| `2b4fe58a-d1b2-4081-8f59-90287b96eba0` | `help-nofisat-2b4fe58a` | legacy status rejected has no new status (rejection_reason must also be preserved) | `collection_status: no equivalent value` | FOUNDER: choose a status for rejected collections (new decision E-COL-2) |

### C05 — Deleted collections — archival timestamp

| Source collection id | Source slug | Source issue | Destination constraint | Proposed transformation category |
|---|---|---|---|---|
| `0c7ddb3c-994b-4884-9d8c-3f0397abd4c2` | `class-pulse-2` | legacy status deleted maps to archived, which requires archived_at; legacy records no deletion time | `collections_archived_has_timestamp` | FOUNDER: E-COL-1 (updated_at as proxy, or another rule) |
| `14a94520-dc96-4891-8f14-4ac54e39be53` | `the-tired-14a94520` | legacy status deleted maps to archived, which requires archived_at; legacy records no deletion time | `collections_archived_has_timestamp` | FOUNDER: E-COL-1 (updated_at as proxy, or another rule) |
| `31ffb6e5-7631-418e-8239-75c8451fa9cc` | `jdjdjd-31ffb6e5` | legacy status deleted maps to archived, which requires archived_at; legacy records no deletion time | `collections_archived_has_timestamp` | FOUNDER: E-COL-1 (updated_at as proxy, or another rule) |
| `4f66f346-db71-4bea-af42-34098134d359` | `aso-ebi-4f66f346` | legacy status deleted maps to archived, which requires archived_at; legacy records no deletion time | `collections_archived_has_timestamp` | FOUNDER: E-COL-1 (updated_at as proxy, or another rule) |
| `59a37f9d-c290-46f5-b6c4-33bbcf30ef7f` | `farstech-installmental-payment--59a37f9d` | legacy status deleted maps to archived, which requires archived_at; legacy records no deletion time | `collections_archived_has_timestamp` | FOUNDER: E-COL-1 (updated_at as proxy, or another rule) |
| `678e6b27-5a5b-4ced-b83a-ae820263b45b` | `engineering-fyb` | legacy status deleted maps to archived, which requires archived_at; legacy records no deletion time | `collections_archived_has_timestamp` | FOUNDER: E-COL-1 (updated_at as proxy, or another rule) |
| `95fda084-b155-4f61-b62b-3e2870607bc6` | `20242025-deptors` | legacy status deleted maps to archived, which requires archived_at; legacy records no deletion time | `collections_archived_has_timestamp` | FOUNDER: E-COL-1 (updated_at as proxy, or another rule) |
| `9ea1c840-3873-4f34-8f81-49ff5f6a28ad` | `20232024-deptors` | legacy status deleted maps to archived, which requires archived_at; legacy records no deletion time | `collections_archived_has_timestamp` | FOUNDER: E-COL-1 (updated_at as proxy, or another rule) |
| `c9881249-a436-4008-a32f-b4b4c7504e48` | `tryvers-collective-cohort-1-c9881249` | legacy status deleted maps to archived, which requires archived_at; legacy records no deletion time | `collections_archived_has_timestamp` | FOUNDER: E-COL-1 (updated_at as proxy, or another rule) |
| `ca0ff709-8fee-43f9-8f60-c73155ee326c` | `this-is-multiple--ca0ff709` | legacy status deleted maps to archived, which requires archived_at; legacy records no deletion time | `collections_archived_has_timestamp` | FOUNDER: E-COL-1 (updated_at as proxy, or another rule) |
| `e82360ad-785e-4d3e-beb4-212dafd824c7` | `royal-soire-engineering-fyb` | legacy status deleted maps to archived, which requires archived_at; legacy records no deletion time | `collections_archived_has_timestamp` | FOUNDER: E-COL-1 (updated_at as proxy, or another rule) |
| `ea2498e0-01bb-4ef3-810b-72a643e7c97a` | `nnssc-017-10th-anniversary-2027-ea2498e0` | legacy status deleted maps to archived, which requires archived_at; legacy records no deletion time | `collections_archived_has_timestamp` | FOUNDER: E-COL-1 (updated_at as proxy, or another rule) |

### C06 — Open-amount collections carrying a legacy amount

| Source collection id | Source slug | Source issue | Destination constraint | Proposed transformation category |
|---|---|---|---|---|
| `07b8c5f6-cecd-4ad5-834c-15aacb755fa4` | `kwasu-students-outreach-26-1` | fundraising collection carries amount 500.00; open_amount may not have a fixed amount | `collections_open_amount_has_no_fixed` | MECHANICAL: fixed_amount_kobo null; legacy amount kept in legacy_collection |
| `20cc1614-e565-4db1-ab79-b81181dd2f5e` | `face-of-maocsa-20cc1614` | open_pool collection carries amount 300.00; open_amount may not have a fixed amount | `collections_open_amount_has_no_fixed` | MECHANICAL: fixed_amount_kobo null; legacy amount kept in legacy_collection |
| `2c77de16-0ea6-4563-a32b-76b8f8534147` | `cribb-26` | fundraising collection carries amount 1000.00; open_amount may not have a fixed amount | `collections_open_amount_has_no_fixed` | MECHANICAL: fixed_amount_kobo null; legacy amount kept in legacy_collection |
| `34b087af-a045-43b7-8f50-fb2ca1aeb1e7` | `nnssc-017-10th-anniversary-2027-34b087af` | open_pool collection carries amount 20000.00; open_amount may not have a fixed amount | `collections_open_amount_has_no_fixed` | MECHANICAL: fixed_amount_kobo null; legacy amount kept in legacy_collection |
| `51b86e12-7d24-4474-8669-c306f55aa046` | `preparation-for-siwes-defence-logistics--51b86e12` | fundraising collection carries amount 1000.00; open_amount may not have a fixed amount | `collections_open_amount_has_no_fixed` | MECHANICAL: fixed_amount_kobo null; legacy amount kept in legacy_collection |
| `6119ed0a-4802-4566-953d-19cf62b24c25` | `graduation-gift-6119ed0a` | open_pool collection carries amount 1000.00; open_amount may not have a fixed amount | `collections_open_amount_has_no_fixed` | MECHANICAL: fixed_amount_kobo null; legacy amount kept in legacy_collection |
| `8255b4fd-b2b3-4fc4-9f26-f5bce502fca4` | `kwasu-students-outreach-26-2` | fundraising collection carries amount 500.00; open_amount may not have a fixed amount | `collections_open_amount_has_no_fixed` | MECHANICAL: fixed_amount_kobo null; legacy amount kept in legacy_collection |
| `91492521-8272-416b-b56d-2b0bc2310bf5` | `linkedin-local-kwasu-91492521` | fundraising collection carries amount 1000.00; open_amount may not have a fixed amount | `collections_open_amount_has_no_fixed` | MECHANICAL: fixed_amount_kobo null; legacy amount kept in legacy_collection |
| `9968c823-cce8-46df-ad31-e4aa99266f75` | `community-project-9968c823` | fundraising collection carries amount 10000.00; open_amount may not have a fixed amount | `collections_open_amount_has_no_fixed` | MECHANICAL: fixed_amount_kobo null; legacy amount kept in legacy_collection |
| `9be4773d-5bb8-47a7-8bb5-e88ec8fea89b` | `helping-aramide-out--9be4773d` | open_pool collection carries amount 200.00; open_amount may not have a fixed amount | `collections_open_amount_has_no_fixed` | MECHANICAL: fixed_amount_kobo null; legacy amount kept in legacy_collection |
| `aafb0d37-e928-45c5-ab19-ba94a2186692` | `the-inner-circle-trust-fund-aafb0d37` | open_pool collection carries amount 500.00; open_amount may not have a fixed amount | `collections_open_amount_has_no_fixed` | MECHANICAL: fixed_amount_kobo null; legacy amount kept in legacy_collection |
| `b5bc7692-a597-4ee0-8e21-ec7c1568aa40` | `devcare-initiative-b5bc7692` | open_pool collection carries amount 500.00; open_amount may not have a fixed amount | `collections_open_amount_has_no_fixed` | MECHANICAL: fixed_amount_kobo null; legacy amount kept in legacy_collection |
| `b724f7d2-82d8-4dfd-9783-50c1ed6c2a40` | `bio-handout-b724f7d2` | fundraising collection carries amount 2000.00; open_amount may not have a fixed amount | `collections_open_amount_has_no_fixed` | MECHANICAL: fixed_amount_kobo null; legacy amount kept in legacy_collection |
| `ba5a7e7e-b150-442d-a696-53cebdd84522` | `final-year-physical-project-and-yearbook-ba5a7e7e` | open_pool collection carries amount 5000.00; open_amount may not have a fixed amount | `collections_open_amount_has_no_fixed` | MECHANICAL: fixed_amount_kobo null; legacy amount kept in legacy_collection |
| `c2de84cf-3999-4df7-a7af-6b410823868a` | `nuesa-support-a-fellow-black-tagger` | fundraising collection carries amount 1000.00; open_amount may not have a fixed amount | `collections_open_amount_has_no_fixed` | MECHANICAL: fixed_amount_kobo null; legacy amount kept in legacy_collection |
| `c842f7d5-7cd6-4697-8eef-40fc42840e39` | `kwasu-students-outreach-26` | fundraising collection carries amount 200.00; open_amount may not have a fixed amount | `collections_open_amount_has_no_fixed` | MECHANICAL: fixed_amount_kobo null; legacy amount kept in legacy_collection |
| `cdcd7a5d-c52b-482b-b1f8-2158d58714ff` | `ramadan-iftar-donation` | fundraising collection carries amount 200.00; open_amount may not have a fixed amount | `collections_open_amount_has_no_fixed` | MECHANICAL: fixed_amount_kobo null; legacy amount kept in legacy_collection |
| `d3e8412c-e743-4631-bc00-206d840a342f` | `nnssc-017-10th-anniversary-2027-d3e8412c` | open_pool collection carries amount 1000.00; open_amount may not have a fixed amount | `collections_open_amount_has_no_fixed` | MECHANICAL: fixed_amount_kobo null; legacy amount kept in legacy_collection |
| `e7e72e87-c828-42cd-8f0a-12be3e9c83bf` | `hod-e7e72e87` | fundraising collection carries amount 2000.00; open_amount may not have a fixed amount | `collections_open_amount_has_no_fixed` | MECHANICAL: fixed_amount_kobo null; legacy amount kept in legacy_collection |
| `e908407c-fce7-49eb-95de-21d82d480ba4` | `payment-e908407c` | open_pool collection carries amount 500.00; open_amount may not have a fixed amount | `collections_open_amount_has_no_fixed` | MECHANICAL: fixed_amount_kobo null; legacy amount kept in legacy_collection |
| `ea2498e0-01bb-4ef3-810b-72a643e7c97a` | `nnssc-017-10th-anniversary-2027-ea2498e0` | open_pool collection carries amount 5000.00; open_amount may not have a fixed amount | `collections_open_amount_has_no_fixed` | MECHANICAL: fixed_amount_kobo null; legacy amount kept in legacy_collection |
| `ed8b984a-7254-4c2b-a25f-c8bbae593e7a` | `nnssc-017-10th-anniversary-reunion-donation-one-time-fixed-payment--ed8b984a` | open_pool collection carries amount 50000.00; open_amount may not have a fixed amount | `collections_open_amount_has_no_fixed` | MECHANICAL: fixed_amount_kobo null; legacy amount kept in legacy_collection |
| `f8e3e6dc-64c8-4294-996c-a48b56e4764d` | `fyb-fee` | fundraising collection carries amount 25000.00; open_amount may not have a fixed amount | `collections_open_amount_has_no_fixed` | MECHANICAL: fixed_amount_kobo null; legacy amount kept in legacy_collection |

### T03 — Duplicate tier names — F-L4

| Source collection id | Source slug | Source issue | Destination constraint | Proposed transformation category |
|---|---|---|---|---|
| `53a33ffd-4412-4ee6-b707-b1e57b58eb2d` | `farstech-siwes-malete-balance--53a33ffd` | 2 tiers share one name (cyber security (physical classes)) | `collection_tiers_unique_name (collection_id, lower(name))` | FOUNDER: F-L4 (rename during import, or relax the rule) |
| `53a33ffd-4412-4ee6-b707-b1e57b58eb2d` | `farstech-siwes-malete-balance--53a33ffd` | 2 tiers share one name (data analysis (physical classes)) | `collection_tiers_unique_name (collection_id, lower(name))` | FOUNDER: F-L4 (rename during import, or relax the rule) |
| `53a33ffd-4412-4ee6-b707-b1e57b58eb2d` | `farstech-siwes-malete-balance--53a33ffd` | 2 tiers share one name (frontend (physical classes)) | `collection_tiers_unique_name (collection_id, lower(name))` | FOUNDER: F-L4 (rename during import, or relax the rule) |
| `53a33ffd-4412-4ee6-b707-b1e57b58eb2d` | `farstech-siwes-malete-balance--53a33ffd` | 2 tiers share one name (ui/ux (physical classes)) | `collection_tiers_unique_name (collection_id, lower(name))` | FOUNDER: F-L4 (rename during import, or relax the rule) |
| `853bca8d-01a4-4470-93d2-c4db105d3b3f` | `siwes-ilorin-sango-area--853bca8d` | 2 tiers share one name (backend development) | `collection_tiers_unique_name (collection_id, lower(name))` | FOUNDER: F-L4 (rename during import, or relax the rule) |
| `853bca8d-01a4-4470-93d2-c4db105d3b3f` | `siwes-ilorin-sango-area--853bca8d` | 2 tiers share one name (cyber security) | `collection_tiers_unique_name (collection_id, lower(name))` | FOUNDER: F-L4 (rename during import, or relax the rule) |
| `853bca8d-01a4-4470-93d2-c4db105d3b3f` | `siwes-ilorin-sango-area--853bca8d` | 2 tiers share one name (data analysis) | `collection_tiers_unique_name (collection_id, lower(name))` | FOUNDER: F-L4 (rename during import, or relax the rule) |
| `853bca8d-01a4-4470-93d2-c4db105d3b3f` | `siwes-ilorin-sango-area--853bca8d` | 2 tiers share one name (frontend development) | `collection_tiers_unique_name (collection_id, lower(name))` | FOUNDER: F-L4 (rename during import, or relax the rule) |
| `853bca8d-01a4-4470-93d2-c4db105d3b3f` | `siwes-ilorin-sango-area--853bca8d` | 2 tiers share one name (graphic design and branding) | `collection_tiers_unique_name (collection_id, lower(name))` | FOUNDER: F-L4 (rename during import, or relax the rule) |
| `853bca8d-01a4-4470-93d2-c4db105d3b3f` | `siwes-ilorin-sango-area--853bca8d` | 2 tiers share one name (iot embedded system) | `collection_tiers_unique_name (collection_id, lower(name))` | FOUNDER: F-L4 (rename during import, or relax the rule) |
| `853bca8d-01a4-4470-93d2-c4db105d3b3f` | `siwes-ilorin-sango-area--853bca8d` | 2 tiers share one name (ui/ux design) | `collection_tiers_unique_name (collection_id, lower(name))` | FOUNDER: F-L4 (rename during import, or relax the rule) |
| `86b80455-6684-477f-9830-6ce9a8d94da0` | `farstech-siwes-malete-86b80455` | 3 tiers share one name (cyber security (physical classes)) | `collection_tiers_unique_name (collection_id, lower(name))` | FOUNDER: F-L4 (rename during import, or relax the rule) |
| `86b80455-6684-477f-9830-6ce9a8d94da0` | `farstech-siwes-malete-86b80455` | 3 tiers share one name (data analysis (physical classes)) | `collection_tiers_unique_name (collection_id, lower(name))` | FOUNDER: F-L4 (rename during import, or relax the rule) |
| `86b80455-6684-477f-9830-6ce9a8d94da0` | `farstech-siwes-malete-86b80455` | 3 tiers share one name (frontend (physical classes)) | `collection_tiers_unique_name (collection_id, lower(name))` | FOUNDER: F-L4 (rename during import, or relax the rule) |
| `86b80455-6684-477f-9830-6ce9a8d94da0` | `farstech-siwes-malete-86b80455` | 3 tiers share one name (ui/ux (physical classes)) | `collection_tiers_unique_name (collection_id, lower(name))` | FOUNDER: F-L4 (rename during import, or relax the rule) |
| `e83c70cc-e36d-4380-92c9-ce15486a1bf5` | `siwes-ilorin-codeverse--e83c70cc` | 2 tiers share one name (cyber security) | `collection_tiers_unique_name (collection_id, lower(name))` | FOUNDER: F-L4 (rename during import, or relax the rule) |
| `e83c70cc-e36d-4380-92c9-ce15486a1bf5` | `siwes-ilorin-codeverse--e83c70cc` | 2 tiers share one name (data analysis) | `collection_tiers_unique_name (collection_id, lower(name))` | FOUNDER: F-L4 (rename during import, or relax the rule) |
| `e83c70cc-e36d-4380-92c9-ce15486a1bf5` | `siwes-ilorin-codeverse--e83c70cc` | 2 tiers share one name (frontend development) | `collection_tiers_unique_name (collection_id, lower(name))` | FOUNDER: F-L4 (rename during import, or relax the rule) |
| `e83c70cc-e36d-4380-92c9-ce15486a1bf5` | `siwes-ilorin-codeverse--e83c70cc` | 2 tiers share one name (ui/ux) | `collection_tiers_unique_name (collection_id, lower(name))` | FOUNDER: F-L4 (rename during import, or relax the rule) |
| `f3cc97a5-48b0-43f4-9bdc-4ca103fd1250` | `ilorin-arptechnology--f3cc97a5` | 2 tiers share one name (cybersecurity + ai automation) | `collection_tiers_unique_name (collection_id, lower(name))` | FOUNDER: F-L4 (rename during import, or relax the rule) |
| `f3cc97a5-48b0-43f4-9bdc-4ca103fd1250` | `ilorin-arptechnology--f3cc97a5` | 2 tiers share one name (data analysis + ai automation) | `collection_tiers_unique_name (collection_id, lower(name))` | FOUNDER: F-L4 (rename during import, or relax the rule) |
| `f3cc97a5-48b0-43f4-9bdc-4ca103fd1250` | `ilorin-arptechnology--f3cc97a5` | 2 tiers share one name (graphic design + ai automation) | `collection_tiers_unique_name (collection_id, lower(name))` | FOUNDER: F-L4 (rename during import, or relax the rule) |
| `f3cc97a5-48b0-43f4-9bdc-4ca103fd1250` | `ilorin-arptechnology--f3cc97a5` | 2 tiers share one name (web design (full stack) + ai automation) | `collection_tiers_unique_name (collection_id, lower(name))` | FOUNDER: F-L4 (rename during import, or relax the rule) |

### T04 — Tier code prefix format

| Source collection id | Source slug | Source issue | Destination constraint | Proposed transformation category |
|---|---|---|---|---|
| `23460ea1-0430-4fd4-8e52-e9bf4ad830f2` | `fars-tech-hub-malete-siwes-payment-23460ea1` | tier #2 prefix FRONT-EN | `collection_tiers_code_prefix_format ^[A-Z0-9]{1,8}$` | ENGINEERING: normalise prefix (upper-case, strip); legacy prefix kept |
| `23460ea1-0430-4fd4-8e52-e9bf4ad830f2` | `fars-tech-hub-malete-siwes-payment-23460ea1` | tier #3 prefix UI/UX | `collection_tiers_code_prefix_format ^[A-Z0-9]{1,8}$` | ENGINEERING: normalise prefix (upper-case, strip); legacy prefix kept |

### T05 — Tier code prefix duplicated within a collection

| Source collection id | Source slug | Source issue | Destination constraint | Proposed transformation category |
|---|---|---|---|---|
| `083799dc-d800-437b-bb5a-ac33e1ac9d84` | `dinner-tickets-083799dc` | 2 tiers share prefix TAB2026 | `collection_tiers_unique_code_prefix (collection_id, code_prefix)` | FOUNDER: prefixes identify contributor codes; disambiguate |
| `4e7bc26f-b2a1-413d-a6e3-90a66f1c691e` | `quantum-fyb-paymet--4e7bc26f` | 8 tiers share prefix QU | `collection_tiers_unique_code_prefix (collection_id, code_prefix)` | FOUNDER: prefixes identify contributor codes; disambiguate |

### T06 — Tier quantity of zero

| Source collection id | Source slug | Source issue | Destination constraint | Proposed transformation category |
|---|---|---|---|---|
| `7ff4a517-d1c1-4dd9-b380-30e5bf1bb807` | `kwara-career-expo-2026-7ff4a517` | tier #2 quantity 0 | `collection_tiers_quantity_positive (> 0 when set)` | MECHANICAL: 0 as unlimited? confirm, else null |

### A01 — Fixed price of zero

| Source collection id | Source slug | Source issue | Destination constraint | Proposed transformation category |
|---|---|---|---|---|
| `06269bf9-96de-4eeb-a4e7-dc1b2c66d24c` | `nnss-017-10th-anniversary-06269bf9` | fixed collection with a price of 0 (satisfies collections_fixed_has_amount_once_published, but is free) | `ADVISORY: no constraint fails` | FOUNDER: confirm a zero fixed price is intended |
| `7b69f7c5-b609-436a-a580-93a4f8d0fea2` | `project--7b69f7c5` | fixed collection with a price of 0 (satisfies collections_fixed_has_amount_once_published, but is free) | `ADVISORY: no constraint fails` | FOUNDER: confirm a zero fixed price is intended |

### A02 — Fixed collections holding price tiers (F-L3 consequence)

| Source collection id | Source slug | Source issue | Destination constraint | Proposed transformation category |
|---|---|---|---|---|
| `06269bf9-96de-4eeb-a4e7-dc1b2c66d24c` | `nnss-017-10th-anniversary-06269bf9` | collection_type fixed but 3 price tiers exist; as fixed, the tiers leave the live model | `ADVISORY: F-L3 consequence` | FOUNDER: confirm under F-L3 (tiers kept in legacy_collection) |
| `7b69f7c5-b609-436a-a580-93a4f8d0fea2` | `project--7b69f7c5` | collection_type fixed but 1 price tiers exist; as fixed, the tiers leave the live model | `ADVISORY: F-L3 consequence` | FOUNDER: confirm under F-L3 (tiers kept in legacy_collection) |

### A03 — Tier-model collection with no tiers

| Source collection id | Source slug | Source issue | Destination constraint | Proposed transformation category |
|---|---|---|---|---|
| `9fa4ef7c-1d23-427a-ac30-47839e4cc20f` | `royal-valley-hike-9fa4ef7c` | ticket collection (amount_model tiers) has no tiers; nothing to sell | `ADVISORY: no constraint fails` | FOUNDER: confirm |

### A04 — Tiers with no stable legacy id

| Source collection id | Source slug | Source issue | Destination constraint | Proposed transformation category |
|---|---|---|---|---|
| `09f50e09-ec9d-4fed-ba13-55567e0befb1` | `gazah-one-09f50e09` | 2 of 2 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `0c7ddb3c-994b-4884-9d8c-3f0397abd4c2` | `class-pulse-2` | 3 of 3 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `10b9ad1b-6b34-476b-8937-43f9f8af9006` | `travel-with-su--10b9ad1b` | 4 of 4 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `127be19a-8761-4343-87ed-3c712f561086` | `mr-and-miss-kwasu-all-white-contestant-unveiling-party` | 2 of 2 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `128c6a53-1a76-4a1d-b992-1ce83d97b5df` | `the-real-one-128c6a53` | 2 of 2 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `1798c7f4-a21f-4dfb-9c90-4c1e2ddd79af` | `hollerpiano-rave-10` | 3 of 3 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `1b87c2d7-97a7-4013-b615-76470359c3a3` | `bonfire-merch` | 3 of 3 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `23af02b0-63b3-4491-85c8-14fef69e2450` | `ammy-haven-foundation-fundraising--23af02b0` | 2 of 2 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `26c48f22-782b-4a2b-9459-f6cd5c67e634` | `naliss-fyb-contribution-26` | 11 of 11 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `295866d5-6c3e-443c-9c43-9064d755a074` | `nacos-fyb-contribution-26` | 12 of 12 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `32413761-15b5-4686-af24-a1f4bcf30c6f` | `bch-wb2s-rave` | 3 of 3 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `32d3f986-66ff-4927-a514-ec201eead193` | `cow` | 3 of 3 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `3762ccbe-089b-4b55-85ff-353c3bc75692` | `wb2s-rave` | 3 of 3 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `388915f8-b191-4945-aba7-dc15213ed2a8` | `travel-with-su-sunday-departure4th-of-january` | 4 of 4 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `42bdffcb-dd27-466b-8fc4-c0ffff049bd8` | `nacos-fyb-26-contribution-single` | 10 of 10 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `44dbcd36-d821-464a-8cbf-f116b2c59cd5` | `good-example-guys-weekly-and-monthly-payments-44dbcd36` | 2 of 2 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `460c7de7-8b71-48df-b613-c8ccfac85e52` | `travel-with-sy` | 4 of 4 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `478d2882-5cfd-4d8c-9d0f-db26c5ce24ea` | `fyb-money` | 3 of 3 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `490b4913-90cc-4f65-b088-13e75df1de0a` | `bamssa-merch` | 1 of 1 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `493a58e4-51c0-4d02-8b76-7c12e0f3a5b5` | `travel-with-s-u-for-friday-s-departees-october-10th-493a58e4` | 4 of 4 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `5478d73c-40f6-4c07-9649-7cb006abff98` | `travel-with-su-wednesday7th-of-jan` | 4 of 4 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `59eada92-fc8a-4609-9dd6-6d742e3adefc` | `y2k-party-tickets-payments` | 4 of 4 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `5f527ba0-9717-4529-871d-b0d8ea80c086` | `orator-odyssey` | 1 of 1 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `5ff1213e-ab3e-49f1-9f33-2cf9350a49b7` | `mr-barrys-night` | 4 of 4 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `6131f2be-6f60-4fec-ba38-bb1a333f67dd` | `travel-with-s-u-for-friday-s-departees-oct-10th-6131f2be` | 4 of 4 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `64c008e1-821d-4a1e-8575-f85d306f9232` | `field-trip-2017` | 1 of 1 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `67dd5926-f9b3-462f-a62d-e344b5ca8a89` | `test-1` | 3 of 3 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `6f84285f-0b42-447d-948f-67d295624bf4` | `night-of-majesty` | 2 of 2 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `708e3489-4b98-4a48-a812-5c82a7d1f69a` | `fft-tutorial-fee` | 2 of 2 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `805121f8-29cc-4b5a-92c4-20fc3b691e8d` | `welcome-back-to-school-rave` | 3 of 3 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `82173bc2-16b9-4661-bc9b-0497b41d8b2b` | `cyto-katakyst-26` | 2 of 2 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `9861d0f5-b787-4cd6-92b0-b167f3f6fcb6` | `fahessa-vest-and-cap` | 3 of 3 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `987418bd-aaea-461d-ae2d-be8fbc79d81f` | `travel-with-su-2nd-of-january-friday-departure` | 4 of 4 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `9baf0f1b-0246-42e6-8183-7517c8986f72` | `engineering-marathon-nights-1` | 1 of 1 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `9bf05c0d-f031-4508-924c-a5c8afc95672` | `savings-for-solomon` | 1 of 1 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `9ea1c840-3873-4f34-8f81-49ff5f6a28ad` | `20232024-deptors` | 12 of 12 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `a042253b-4719-4a03-9e61-254e1e9ab299` | `testing--a042253b` | 1 of 1 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `a6db794a-1a6b-4e1c-be74-11f009b0bd6e` | `travel-with-s-u-for-friday-departees-october-3rd-a6db794a` | 4 of 4 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `a7a71775-c8c7-42d7-8612-3d4b217f0239` | `the-cribb-26` | 1 of 1 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `a89f6e8b-16d8-45e8-bd63-e34fc5b7a0ab` | `iict-picnic-hangout` | 2 of 2 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `abc6f507-49e4-4b1d-99b9-0c999afd69a0` | `handout-2` | 1 of 1 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `b456af0f-5abc-4679-ad98-816f9a637fcc` | `travel-with-s-u-for-sunday-departees-october-5th-b456af0f` | 4 of 4 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `bef49be7-defb-4370-8204-69c25fc8f95f` | `fyb-fee-1` | 2 of 2 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `c1513a46-f40a-4687-b6f4-5e90b5aa0260` | `travel-with-su` | 3 of 3 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `ca0ff709-8fee-43f9-8f60-c73155ee326c` | `this-is-multiple--ca0ff709` | 2 of 2 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `d206163b-fecd-4bbb-96c2-b4f86b666b9b` | `adas-d206163b` | 2 of 2 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `d49fc74e-658b-4338-adf2-5e292572aa0b` | `travel-with-su-2` | 4 of 4 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `da009f0b-cdb9-426b-8c34-1fc9d041ed75` | `cse409-handout` | 1 of 1 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `dc73ec00-b2b1-4871-8d5d-0441404b9d2b` | `technocrats-cds-monthly-due` | 15 of 15 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `dd54f96e-4cf2-4c71-86ca-4b848b87da97` | `convocation` | 1 of 1 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `de16e466-7780-4513-81f5-212d427a63e3` | `testing-2` | 1 of 1 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `e39ab920-f815-4eb2-96ec-5bcce34fa3fb` | `research-data-analysis-for-beginners-to-experts` | 2 of 2 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `e4afcb15-d4e2-46aa-8eb0-fad652fe56e5` | `the-student-kitchen-payment-plan` | 4 of 4 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `e87478c4-27b1-4820-910d-9dd2bf44eb08` | `booking-an-hotel-for-event` | 1 of 1 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `ed014647-c504-457b-b895-cb601eaaec46` | `nuesa-book-ads` | 3 of 3 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `ef8c1a78-0420-4c9d-804a-372b35af2335` | `travel-with-su-1` | 4 of 4 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `f42d4a04-fac3-4216-864f-b68bd98dd8e1` | `engineering-marathon-nights` | 3 of 3 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |
| `fbfac2e1-3465-4981-b3e4-9108d8719468` | `bokk` | 3 of 3 tiers have no legacy id | `ADVISORY: no stable tier id` | ENGINEERING: new UUIDs; history links by collection + name + price only |

## 4. What this changes

**Resolved by measurement — no decision needed after all:**

- **Slugs.** Every legacy slug already fits the new format and no organizer reuses
  one. The "slug normalisation" engineering item is unnecessary.
- **Lengths and money.** No description, story or tier name is too long; no amount is
  negative or imprecise; every collection is NGN.

**Concrete founder decisions, now as rows:**

| Decision | Rows | Collections |
|---|---|---|
| **F-L4** — duplicate tier names | 23 name groups | 5 |
| **E-COL-1** — archival time for deleted collections | 12 | 12 |
| **E-COL-2 (new)** — status for a `rejected` collection | 1 | 1 |
| **Title too long** (new) | 1 | 1 |
| **Tier code prefixes** (new) — format and duplicates | 4 | 3 |
| **Tier quantity 0** (new) — unlimited, or none? | 1 | 1 |
| **M7** — confirm open/public for every legacy collection | all 275 | 275 |

**Advisories to confirm, not block:** A01 (2), A02 (2),
A03 (1). A04 records that 58 collections have tiers
without a legacy id: those tiers get new UUIDs, and historical contributions can be
linked to them only by collection, name and price — tolerable for history, as the
collection model already concluded.

**A correction to the older documentation.** legacy-collection-model.md §4 says 200
of 305 tier entries have no `id`. Measured today: **137 carry an `id` key, 168 do
not.**

## 5. Method and reproducibility

- Query: one read-only statement over `public.collections` and its `price_tiers`
  jsonb, in a session with `default_transaction_read_only = on`.
- Output: identifiers, lengths and reasons only. **No title, description or personal
  data is reproduced here.** Collection ids and slugs are included because each
  decision needs to name its rows.
- Ordering: by finding code, then source collection id — rerunning produces the same
  report.
- Source integrity: the D2 restore was verified against all 45 control totals on
  2026-09-27 (D2-RESTORE-VERIFICATION.md) and has not been written since.
