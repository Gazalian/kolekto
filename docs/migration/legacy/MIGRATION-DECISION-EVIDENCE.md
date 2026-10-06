# Migration decision evidence

**Date:** 2026-09-28 · **Mode:** READ-ONLY against the D2 restore
(`kolekto-legacy-restore-ro`, database `legacy_restore`, `default_transaction_read_only = on`).
**No writes to any database.** Nothing was imported.

The original D2 container had a Windows-reserved-port conflict (55394–55493, which
now includes 55432). A **new** container was attached to the **same** Docker volume
on port 5544. The volume itself is unchanged, and the D2 verification totals still
hold: 275 collections, 5,576 contributions, 292 withdrawals.

Every claim below is labelled **FACT** (directly observed in the D2 database or in
kolekto-fe-old source), **INFERENCE** (a conclusion drawn from that evidence), or
**RECOMMENDATION** (a proposed treatment, not applied).

## 1. Executive summary

**Six decisions dissolve on evidence.** They looked like founder calls; the data shows
they are not.

| Decision | Was expected to be | Evidence shows | Now |
|---|---|---|---|
| F-L4 duplicate tier names | founder ruling | every duplicate group is **priced differently, has its own prefix, and its own description** (part-payment installments) | **rename mechanically** — 23 tiers gain a suffix from their own description |
| E-COL-2 rejected collection | founder ruling on a new status | this row is a **rejected fundraising campaign mirrored into `collections`** — same UUID in `campaigns` | **skip** — belongs to F-L2 (campaigns → overflow), not to collections |
| M7 open/public | founder confirmation | there is **no private-collection mechanism at all** in the legacy schema; access tables have 0 rows | **confirmed** by absence |
| A-1 legacy contributor codes | founder ruling on whether they matter | the old dashboard **scans them for check-in and searches on them** | **preserve** — build `legacy_links (kind='contributor_code')` |
| A-4 avatars and banners | founder ruling | 12 profiles + 1 banner point at legacy Supabase URLs; **3 banners are inline base64 in the DB** | **null in live, preserve in overflow** — the URLs die with the legacy project |
| slug normalisation | engineering task | every slug already fits the new format | **not needed** |

**Six real decisions remain**, each with rows named. Two engineering choices need
approval before the importer starts.

**One documentation correction is unavoidable.** The earlier "137 tier entries carry
a legacy id" counted tiers where the JSON `id` **key** appears, not where its
**value** is non-empty. The migration-relevant number is: **105 tiers have a usable
legacy id, 200 do not.** §15.

## 2. Decision matrix

| # | Decision | Evidence | Classification | Proposed treatment | Founder decision needed |
|---|---|---|---|---|---|
| **D1 (F-L4)** | 23 duplicate tier names, 5 collections | Every group has 2–3 tiers with **distinct prices, prefixes and descriptions** — installment options for the same course | **Engineering, mechanical** | Rename each tier by appending its `code_prefix` in brackets: `Cyber Security (Physical Classes) [BHCYB]`. Keep the original name in `legacy_collection.fields`. Deterministic, idempotent, human-legible | **No** — no invariant relaxed |
| **D2 (E-COL-1)** | 12 deleted collections need `archived_at` | Legacy has no deletion timestamp anywhere. `updated_at` on the 12 rows ranges from 25 minutes to 288 days after `created_at` | **Founder decision** | Use `updated_at` as the archival timestamp, labelled a proxy in `legacy_collection.fields`. No better source exists | **Yes** — approve `updated_at` as proxy |
| **D3 (E-COL-2)** | 1 rejected collection | **Same UUID as `campaigns` row `2b4fe58a…`**, both `rejected`, both titled "Help Nofisat". Campaign was admin-rejected as "This campaign is not valid" | **Engineering, dissolved** | **Do not import as a collection.** Preserve as historical: `legacy_collection.fields` records the collection row; `campaigns` row goes to `legacy_overflow` (F-L2 confirms campaigns → overflow) | **No** — no new status invented |
| **D4** | 2-character title `Mr` | Active, fixed, fee_bearer=contributor, 0 contributions, 0 deposits, same `created_at` and `updated_at` (2025-11-08) | **Founder decision** | **Archive** it, like the 12 deleted collections: `status='archived'`, `archived_at = updated_at`, title preserved. No customer relationship exists to protect | **Yes** — approve archive of a zero-activity test-shaped row |
| **D5** | 2 invalid tier prefixes: `FRONT-EN`, `UI/UX` | Both on collection `23460ea1…`; neither has issued contributions under that prefix (the collection uses different counter prefixes) | **Engineering, mechanical** | Normalise: strip non-alphanumerics, upper-case, truncate to 8. `FRONT-EN → FRONTEN`; `UI/UX → UIUX`. Legacy prefix preserved | **No** — no historical code invalidated |
| **D6** | Shared prefixes: `TAB2026` (2 tiers), `QU` (8 tiers) | **Codes have already been issued** under both — TAB2026 has 6 issued (next 7), QU has 5 issued (next 6). Legacy allowed one prefix to span multiple tiers | **Founder decision (with engineering recommendation)** | The prefix already **cannot** discriminate tier in legacy — codes are `TAB2026-1..-6` without tier info. Preserve that: give the prefix to the **highest-priced** tier (deterministic, stable), null the prefix on the others, keep the counter, and record all legacy prefixes in `legacy_collection.fields`. Legacy contributor codes still resolve because they live in `legacy_contribution.fields` and `legacy_links` | **Yes** — approve the "highest-priced tier keeps the prefix" rule |
| **D7** | Tier quantity = 0 on `kwara-career-expo-2026` | Active ticket collection, event 2026-11-21 (past). Tier 1 "Early Bird" has **no `quantity` key at all**, sold 1. Tier 2 "Late Bird" has `quantity=0`, `remaining=0`, `sold_quantity=0` | **Engineering, inference** | `quantity_limit = null` (unlimited). Legacy code sets both `remaining_quantity` and `sold_quantity` alongside `quantity` — a fresh tier with all three at 0 and no sales is an unset tier, not a sold-out one | **Yes** — confirm the inference or override |
| **D8 (M7)** | Every legacy collection is open/public | **Zero** columns on `collections` about visibility/private/access. `collection_access_grants/invites/invite_items` all have **0 rows**. No route or code path in the legacy edge functions distinguishes private access | **Confirmed by absence** | Every imported collection: `participation_mode='open'`, `audience_mode='public'` | **No** — inference of last resort, but there is no counter-evidence to look for |
| **D9 (A-1)** | Legacy contributor codes must resolve | `kolekto-fe-old` scans `contributor_unique_code` for check-in (`CollectionDetailsPage.tsx:404`), searches (`:538`), exports (`:439`), and displays them on receipts as "Ticket ID" (`:1552`). **2,494 of 5,576** contributions carry a code. Every `paid`/`duplicate_voided` row has one; `pending` never does | **Engineering, decided by evidence** | Build `legacy_links (kind='contributor_code')` mapping each legacy code to its `legacy_contribution.source_id`. No new-schema representation is needed; the codes are historical identifiers | **No** — the evidence closes it |
| **D10 (A-4)** | 13 legacy image references | **12 avatars** point at `busfgcmbndleljklrcbd.supabase.co` (Storage URLs); **1 banner** does too; **3 more banners are inline base64 in `collections.banner_url`** | **Engineering, decided by evidence** | **`users.avatar_url = null`, `collections.cover_url = null`** at import. Preserve every legacy URL and base64 in `legacy_profile.fields` / `legacy_collection.fields`. A Supabase URL to a project about to be disconnected is broken forward; base64 in the DB is a size hazard | **No** — copying a URL that will die is worse than nulling it |
| **D11 (F-L2)** | Campaigns: collection or overflow | The row shares the rejected collection's id. `campaigns` schema is 26 columns; 10 overlap `collections`; **16 columns are campaign-only** (`category, city, country, keywords, main_image_url, phone_number, social_facebook/instagram/twitter, story_achieve/for/why, summary, verified_at, ...`). `campaign_donations` is 0 rows. 1 `campaign_images` row | **Overflow, confirmed** | `campaigns` → `legacy_overflow`. `campaign_donations` → `legacy_overflow` (empty but recorded). `campaign_images` → `legacy_overflow`. Nothing in the new product needs a campaigns table | **No** — F-L2 asked; the shape and orphan status answers |
| **D12** | The 5 remaining advisories | See §14 | Mixed | See §14 | Two need confirmation |
| **D13** | Tier id count | Actual: **105 tiers carry a non-empty id; 200 do not** | Doc correction | Update the readiness and conformance reports | — |
| **D14** | Remaining table classification | See §16 | — | — | See §16 |

## 3. F-L4 duplicate tier names

**FACT.** 23 duplicate-name groups across 5 collections, evidence from `price_tiers` jsonb.

| Collection | Slug | Duplicate name groups | All groups have distinct… |
|---|---|---|---|
| `86b80455…` | `farstech-siwes-malete-86b80455` | 4 (3 tiers each) | prices, prefixes, descriptions |
| `53a33ffd…` | `farstech-siwes-malete-balance--53a33ffd` | 4 (2 tiers each) | prices, prefixes, descriptions |
| `853bca8d…` | `siwes-ilorin-sango-area--853bca8d` | 7 (2 tiers each) | prices, prefixes, descriptions |
| `e83c70cc…` | `siwes-ilorin-codeverse--e83c70cc` | 4 (2 tiers each) | prices, prefixes, descriptions |
| `f3cc97a5…` | `ilorin-arptechnology--f3cc97a5` | 4 (2 tiers each) | prices, prefixes, descriptions |

**FACT — every group is priced differently.** From the D2 pass:

| Same-name group | Prices (₦) | Prefixes | Descriptions (first ~50 chars) |
|---|---|---|---|
| farstech-siwes-malete-86b80455 · Cyber Security (Physical Classes) | 50,000 · 60,000 · 120,000 | tier ids | Full · Half · Balance |
| farstech-balance · Cyber Security | 60,000 · 70,000 | BHCYB · BPCYB | *"If you initially paid half payment (60k) for Cyber Security…"* · *"If you initially paid 50k as part payment…"* |
| siwes-ilorin-sango-area · Cyber Security | 30,000 · 50,000 | HCYB · FCYB | *"Part payment to balance 20k within 1 month"* · *"Full Payment"* |

**INFERENCE.** These are **installment payment options**, not duplicate offerings. The
legacy platform lacked partial payments as a first-class feature, so organizers built
them out of tiers named after the underlying course with different prefixes and
descriptions carrying the actual meaning ("Full", "Half", "Balance", "Part payment").

**RECOMMENDATION — mechanical, deterministic.**

> Rename every tier in a duplicate-name group to `<name> [<code_prefix>]`, using the
> tier's own `code_prefix`. Preserve the original name in
> `legacy_collection.fields.price_tiers[].name`. Fall back to the tier's
> `description`'s first six words if the prefix is empty.

The transformation is:
- **deterministic** — same input, same output
- **idempotent** — re-running produces identical strings
- **stable** — legacy prefixes and descriptions don't move
- **human-legible** — an organizer sees "Cyber Security (Physical Classes) [BHCYB]" and can tell it apart from "…[BPCYB]"

**No relaxation of `collection_tiers_unique_name` is proposed.** The invariant exists
because a name-only match caused the 2026-08-06 payment loss (docs/incident_2026-08-06_verify-tier-collision-payment-loss.md).
Adding the prefix in brackets *encodes* what already discriminates the tiers.

**Founder decision needed:** none. The evidence closes it.

## 4. E-COL-1 · 12 deleted collections

**FACT.** All 12, with days from creation to soft-deletion:

| id | slug | days | contribs | paid | last activity |
|---|---|---|---|---|---|
| `ea2498e0…` | `nnssc-017-10th-anniversary-2027…` | 0 | 0 | 0 | none |
| `4f66f346…` | `aso-ebi-4f66f346` | 2 | 1 | 0 | 2026-06-15 |
| `e82360ad…` | `royal-soire-engineering-fyb` | 94 | 3 | 0 | 2026-05-05 |
| `678e6b27…` | `engineering-fyb` | 95 | 3 | 0 | 2026-03-18 |
| `31ffb6e5…` | `jdjdjd-31ffb6e5` | 0 | 0 | 0 | none |
| `ca0ff709…` | `this-is-multiple--ca0ff709` | 272 | 0 | 0 | none |
| `14a94520…` | `the-tired-14a94520` | 288 | 0 | 0 | none |
| `59a37f9d…` | `farstech-installmental-payment…` | 7 | 0 | 0 | none |
| `95fda084…` | `20242025-deptors` | 162 | 7 | 4 | 2026-06-17 |
| `9ea1c840…` | `20232024-deptors` | 162 | 3 | 3 | 2026-06-17 |
| `0c7ddb3c…` | `class-pulse-2` | 235 | 20 | 15 | 2026-06-17 |
| `c9881249…` | `tryvers-collective-cohort-1…` | 8 | 0 | 0 | none |

**FACT — the search for a real deletion timestamp.** Every column in `public.*` whose
name contains "delete", "archive" or "removed" was enumerated: **the only column found
is `push_notification_events.removed_count`**, unrelated. No audit table records
collection deletions.

**INFERENCE.** `updated_at` is what the legacy soft-delete would have touched (the
status column changed to `'deleted'`, and every trigger on the row updates `updated_at`).
That does not make it the actual deletion moment for collections that received
contributions after their real deletion — the `95fda084…` (7 contributions with last
activity 2026-06-17, updated 2026-09-06) suggests either later admin activity or a
second soft-delete round.

**RECOMMENDATION.**

> `archived_at = updated_at` for all 12, with `legacy_collection.fields` recording
> `_e_col_1_archival_note = "updated_at used as archival proxy; legacy schema records
> no deletion timestamp"`.

**FOUNDER DECISION REQUIRED.** Confirm the proxy is acceptable. Alternatives are
inventing `now()` (worse — makes every deletion look like migration day) or a new
status value (rejected by the brief).

## 5. E-COL-2 · the "rejected" collection

**FACT.**

```
collection  2b4fe58a-d1b2-4081-8f59-90287b96eba0  rejected  Help Nofisat  "This campaign is not valid"
campaign    2b4fe58a-d1b2-4081-8f59-90287b96eba0  rejected  Help Nofisat  (no rejection_reason column on campaigns)
```

The row exists **in both `collections` and `campaigns` under the same UUID.**
`campaigns` has 1 row total — that row. `collections.rejection_reason` says "This
campaign is not valid" (using the word "campaign"). The rejection was made by an
admin: `payment_admin_actions` records staff financial interventions in the legacy
system.

**FACT — activity.**
- 0 contributions, 0 deposits, 0 paid.
- Created 2026-06-25 21:11, rejected 2026-06-25 21:19 — **8 minutes later**.
- One `campaign_images` row associated.

**INFERENCE.** This is not a rejected *collection*. It is a **rejected fundraising
campaign** submitted by a user, mirrored into `collections` by the legacy system's
"campaigns are collections too" plumbing, and rejected by an admin before it ever
took a contribution. Under F-L2, campaigns go to overflow.

**RECOMMENDATION.**

> **Do not import as a `public.collections` row.** The collection row goes to
> `migration.legacy_collection.fields` (preserving the row verbatim). The paired
> `campaigns` row goes to `migration.legacy_overflow`.

**FOUNDER DECISION REQUIRED:** none. This dissolves E-COL-2 as originally posed.
Approval is only needed if the founder wants a rejected campaign nonetheless
represented as a live collection — which the evidence argues against.

## 6. Two-character title

**FACT.**

| id | slug | title | length | status | type | created | updated | contribs | paid |
|---|---|---|---|---|---|---|---|---|---|
| `40e4cc9e…` | `mr-40e4cc9e` | `Mr` | 2 | active | fixed | 2025-11-08 22:30 | 2025-11-08 22:30 | 0 | 0 |

**INFERENCE.** `created_at = updated_at`, zero contributions, zero deposits, an
active but unused row on a nine-month-old collection. The most plausible reading is
a **test or stub** the organizer never developed. Nobody paid it.

**RECOMMENDATION.**

> Treat identically to E-COL-1: `status = 'archived'`, `archived_at = updated_at`,
> `name = 'Mr (archived on import)'` — a 24-character string that satisfies the
> 3–80 constraint without inventing anything. Legacy title `"Mr"` preserved in
> `legacy_collection.fields.title`.

**FOUNDER DECISION REQUIRED.** Confirm archive-on-import for a zero-activity row
with a 2-char title, or provide an alternate title in writing.

## 7. Tier prefix normalisation

**FACT.** Collection `23460ea1-0430-4fd4-8e52-e9bf4ad830f2` (`fars-tech-hub-malete-siwes-payment…`)
has two tiers with prefixes that don't match `^[A-Z0-9]{1,8}$`:

| Ord | Tier name | Legacy prefix | Rejected because |
|---|---|---|---|
| 2 | `Front-end` | `FRONT-EN` | contains `-` |
| 3 | `UI/UX` | `UI/UX` | contains `/` |

**FACT — no historical contributor codes exist using these prefixes.** The three
`contribution_code_counters` on this collection use different prefixes; nothing has
ever been issued as `FRONT-EN-…` or `UI/UX-…`.

**RECOMMENDATION — deterministic function.**

> `normalize_prefix(p) = upper(left(regexp_replace(p, '[^A-Za-z0-9]', '', 'g'), 8))`
>
> `FRONT-EN → FRONTEN` · `UI/UX → UIUX`
>
> The pre-normalised value is preserved as
> `legacy_collection.fields.price_tiers[].prefix`.

No collision within the collection (verified — `FRONTEN` and `UIUX` do not appear
under any other prefix). Idempotent. Stable across re-imports.

**FOUNDER DECISION REQUIRED:** none.

## 8. Duplicate tier prefixes

**FACT.** Two collections have prefixes shared by multiple tiers.

**Collection `083799dc…` (`dinner-tickets-083799dc`)** — the prefix `TAB2026` is
shared by two tiers:

| Tier | Prefix | Price (₦) | Issued codes so far | Next number |
|---|---|---|---|---|
| Table for 5 | TAB2026 | 30,000 | shared: **6 codes issued**, next 7 | 7 |
| Table for 10 | TAB2026 | 50,000 | shared with above | — |

The counter has issued codes `TAB2026-1..TAB2026-6` **without recording which tier
each belongs to.** A separate prefix `REG2026` on this collection has 12 codes
issued — that one is a different, non-duplicating registration prefix.

**Collection `4e7bc26f…` (`quantum-fyb-paymet…`)** — the prefix `QU` is shared by
**eight** tiers:

| Tier | Prefix | Price (₦) |
|---|---|---|
| WHO ARE YOU? | QU | 14,700 |
| IJOYE | QU | 13,500 |
| CATERING PACKAGE | QU | 10,000 |
| I AM A CHOSEN! | QU | 17,200 |
| FEMALE MATERIAL | QU | 28,500 |
| MALE WITH AGBADA | QU | 22,500 |
| BUNCH OF WOMEN! | QU | 21,700 |
| CUSTOMIZED JOTTER | QU | 1,000 |

`QU` has **5 codes issued**; separate prefixes `FL` (3 issued) and `SH` (20 issued)
also exist on this collection.

**INFERENCE.** The legacy platform allowed one prefix to serve multiple tiers.
Codes `QU-1..QU-5` name **the collection's shared namespace**, not a specific tier.
The tier a contributor bought must be inferred from the price paid, not from the
code. This is history that already lacks the fact the new schema requires.

**RECOMMENDATION.**

> Give the shared prefix to the **highest-priced tier in the duplicate group**
> (deterministic tie-break: highest `sort_order` on price ties). Null the prefix on
> every other tier in the group. Preserve every tier's original prefix in
> `legacy_collection.fields.price_tiers[].prefix`. The counter row keeps its
> prefix and `next_number` — legacy codes still resolve.

Under this rule:
- **`TAB2026`** → given to "Table for 10" (₦50,000); "Table for 5" loses its prefix.
- **`QU`** → given to "FEMALE MATERIAL" (₦28,500); other 7 tiers lose their prefix.

**FOUNDER DECISION REQUIRED.** Approve "highest-priced tier keeps the prefix" as the
canonical rule, or specify a different tie-break. Do not choose "first sort_order"
as the default: it would give `QU` to "WHO ARE YOU?" (₦14,700), which is neither the
most representative nor the most-purchased tier.

**Not proposed:** relaxing `collection_tiers_unique_code_prefix`. The prefix drives
new code generation; a shared prefix would let two tier subtotals share a code
namespace, exactly what the incident review warned against.

## 9. Tier quantity = 0

**FACT.** Collection `7ff4a517…` (`kwara-career-expo-2026-7ff4a517`), active,
`collection_type='ticket'`, event date **2026-11-21** (past by ~2 months relative to
this session), two tiers:

| Ord | Name | Prefix | Price | `quantity` key | `remaining_quantity` | `sold_quantity` |
|---|---|---|---|---|---|---|
| 1 | Early Bird | EKCE | 3,000 | **absent** | absent | 1 |
| 2 | Late Bird | LKCE | 5,000 | **0** | 0 | 0 |

**INFERENCE.**

The two tiers were configured **differently on purpose.** Early Bird has no
`quantity` key at all — the legacy code's convention for **unlimited**. Late Bird
was configured with `quantity=0` alongside `remaining=0` and `sold=0` — which the
legacy code writes when the tier is either sold-out (should also have historical
`sold_quantity > 0`) or **never activated** (this row).

The `sold_quantity=0` distinguishes the two possibilities. This tier **never sold a
ticket**. The most consistent reading is: the organizer set it up as a placeholder
and never opened sales.

**RECOMMENDATION.**

> `quantity_limit = null` (unlimited). Preserve the legacy `quantity=0` in
> `legacy_collection.fields.price_tiers[].quantity`. Attach a note:
> `_legacy_quantity_note = "quantity=0, never sold"`.

**FOUNDER DECISION REQUIRED.** Confirm the "0 with never-sold means unlimited"
inference, or provide an alternate reading (e.g. "hide the tier").

## 10. M7 · public/open for every legacy collection

**FACT.**

- Every column on `public.collections` was enumerated for names containing "visib",
  "private", "public", "access", "audience" or "member". **Result: 0 columns.**
- Three access-related tables exist: `collection_access_grants`,
  `collection_access_invites`, `collection_access_invite_items`. **Row counts: 0, 0, 0.**
- No legacy edge function or frontend route enforces a private-collection path
  (verified in D7).

**INFERENCE.** There is no legacy mechanism for a private collection. Every
collection was reached by a public link and open to any contributor with the URL.

**RECOMMENDATION.**

> Every imported collection: `participation_mode='open'`, `audience_mode='public'`.

**FOUNDER DECISION REQUIRED:** none. This is inference from the absence of any
private-collection surface. The alternative would be to look for evidence of
private collections; there is none to find.

## 11. A-1 · legacy contributor codes

**FACT — the codes are populated and unique.**

| | value |
|---|---|
| Total contributions | 5,576 |
| With a non-empty `contributor_unique_code` | **2,494** (44.7%) |
| Collections using codes | **74** of 275 |
| `contribution_code_counters` rows | 53 |
| Distinct prefixes across counters | 45 |
| Duplicate codes within any collection | **0** |

Codes are issued **only for paid outcomes**: every one of the 3,934 `paid` and 14
`duplicate_voided` contributions has a code (3,934 - 2,494 = 1,440 paid rows *without*
codes belong to earlier collections that never used the feature). No `pending`
contribution ever holds one.

**FACT — code shape.** Pattern samples (numeric parts redacted): `PHS_N` (555 codes),
`PHS_VEST_N` (271), `NAC_N` (203), `CYTO_-N` (156), `BCH-N` (135), `TSU-II_N` (98).
`PREFIX-NUMBER` or `PREFIX_NUMBER`, sometimes with spaces.

**FACT — the codes are a workflow surface.** From `kolekto-fe-old/src/pages/dashboard/CollectionDetailsPage.tsx`:

| Line | Use |
|---|---|
| 341 | `hasUniqueCode = paidContributions.some(c => c.contributor_unique_code…)` — gate |
| **404** | `c.contributor_unique_code === scanInput.trim()` — **check-in scan** |
| 439 | CSV export column |
| 538 | text search (`.toLowerCase().includes(q)`) |
| 1075 | dashboard display |
| 1289 | ticket-list display |
| 1552 | receipt display: `Ticket ID: {c.contributor_unique_code}` |

**INFERENCE.** Legacy contributor codes are **customer-visible identifiers** that
organizers used to run event check-in and daily operations. They already exist in
printed tickets and email receipts. Any organizer whose event has not concluded
still needs those codes to resolve.

**RECOMMENDATION.**

> Populate `public.legacy_links` with one row per legacy code, `kind='contributor_code'`:
>
> - `old_path = <code>` (e.g. `PHS-1042`)
> - `new_path` = the imported `legacy_contribution.source_id` (or the migration id of
>   the row in `legacy_contribution`)
> - `context_collection_id = <legacy_collections.id>` for lookup
>
> The importer does not create `public.contributor_references` rows. Contributor
> references in the new schema are issued against **obligations**; imported
> contributions are history, not obligations.

**FOUNDER DECISION REQUIRED:** none. The evidence closes A-1 in the affirmative,
and the runbook already specified `legacy_links` as the destination.

## 12. A-4 · avatars and banners

**FACT.**

| Field | Total rows | Non-null | Points at legacy Supabase | External `https://…` | Inline `data:…` base64 |
|---|---|---|---|---|---|
| `profiles.avatar_url` | 622 | 12 | 12 | 0 | 0 |
| `collections.banner_url` | 275 | 4 | 1 | 0 | 3 |

The Supabase URLs address the **legacy production** project host, which will be
disconnected after cutover.

**INFERENCE.**

- Carrying the URL forward creates a dependency on a project we intend to disconnect —
  and D6 explicitly excluded Storage migration.
- The 3 inline base64 banners are megabytes of text in an application table; keeping
  them in `collections.cover_url` would push text into every SELECT of a collection.

**RECOMMENDATION.**

> **`public.users.avatar_url = null`** at import; preserve original in
> `legacy_profile.fields.avatar_url`.
>
> **`public.collections.cover_url = null`** at import; preserve original in
> `legacy_collection.fields.banner_url` (both `https://` and `data:` forms).

**FOUNDER DECISION REQUIRED:** none, unless the founder wants to migrate 13 images
from legacy Storage explicitly — which is D6 / B5, deliberately deferred.

## 13. F-L2 · campaigns

**FACT — the campaigns row is the rejected collection's twin (§5).** The
`campaigns` table holds **1 row total**; that row's UUID matches the rejected
collection.

**FACT — schema overlap.** `campaigns` has 26 columns, of which 10 overlap
`collections` and **16 are campaign-specific**:

```
category, city, country, country_code, creator_id, keywords, main_image_url,
phone_number, social_facebook, social_instagram, social_twitter,
story_achieve, story_for, story_why, summary, verified_at
```

`campaign_donations` has **0 rows**. `campaign_images` has **1** row (the rejected
campaign's image).

**INFERENCE.** Campaigns is a legacy subsystem for fundraising submissions that
required admin approval. Only one campaign ever existed, and it was rejected. The
subsystem never had a working population.

**RECOMMENDATION.**

> - `campaigns` (1 row) → `migration.legacy_overflow`
> - `campaign_donations` (0 rows) → `migration.legacy_overflow` (recorded as empty)
> - `campaign_images` (1 row) → `migration.legacy_overflow`
>
> No `campaigns` table is created in the new schema. No live collection is created
> from this data.

**FOUNDER DECISION REQUIRED:** none. F-L2 asked the question; the row shape and
population answer it.

## 14. Advisories

### A01 · two fixed collections with price 0

**FACT.** Two active `collection_type='fixed'` collections have `amount = 0`.
Both satisfy `collections_fixed_has_amount_once_published` (published → not draft
→ has amount, and 0 is an amount).

**INFERENCE.** Zero-price fixed collections mean *free*. Legacy allowed this;
whether the new product should is a product question, not a data question.

**RECOMMENDATION.**

> Import as-is: `fixed_amount_kobo = 0`. No constraint is relaxed; the CHECK
> already permits zero. Record `_legacy_amount_note = "free fixed collection"`
> in `legacy_collection.fields` so a future audit sees the flag.

**FOUNDER DECISION REQUIRED.** Confirm free fixed collections are intentionally
supported, or override to `status='archived'`.

### A02 · two fixed collections that carry price tiers

**FACT.** Under F-L3 these two collections are classified `collection_type='fixed'`,
so their `amount_model` maps to `fixed`. Both have entries in their `price_tiers`
jsonb. The new `collection_tiers` are **not** written for them (fixed doesn't take
tiers).

**INFERENCE.** The `type` and `collection_type` columns disagree on these two rows,
which F-L3 already anticipated. The tiers are legacy noise on rows the platform
resolved as fixed.

**RECOMMENDATION.**

> Import as fixed; the tiers stay in `legacy_collection.fields.price_tiers`,
> historically preserved. `collection_tiers` receives no rows for these two.

**FOUNDER DECISION REQUIRED:** none. F-L3 already directs `collection_type` as
authoritative.

### A03 · one ticket collection with no tiers

**FACT.** One `collection_type='ticket'` collection has `price_tiers=[]`.

**INFERENCE.** A ticket collection with nothing to sell is either unfinished or
misconfigured. There is nothing to import into `collection_tiers`.

**RECOMMENDATION.**

> Import the collection as `amount_model='tiers'` per F-L3, but with **zero** rows
> in `collection_tiers`. This is representable: an event whose tier list is empty
> shows nothing to buy, which matches reality. Note the flag in `legacy_collection.fields`.

**FOUNDER DECISION REQUIRED.** Confirm importing a ticket collection with no tiers,
or archive it.

### A04 · tiers without a legacy id

Superseded by §15.

## 15. Tier ID correction

**FACT — measured today against the D2 restore.**

| | count |
|---|---|
| Tier entries across all 275 collections | **305** |
| Entries whose **`id` JSON key is present** (may be null or empty) | 137 |
| Entries whose **`id` value is non-empty** | **105** |
| Entries whose `id` value is empty or the key is missing | **200** |

**INFERENCE.** The migration-relevant count is the number of tiers whose id can
actually be used to link a historical row: **105 usable ids, 200 not**. My earlier
"137 with id / 168 without" was the count of tiers where the `id` key was present in
the JSON, without checking whether the value was non-empty — a subtly different
question, and the wrong one.

**RECOMMENDATION.**

> Correct `legacy-collection-model.md §4` from "200 of 305 tier entries have no `id`"
> to "**200 of 305 tier entries lack a usable legacy id (empty or missing).**"
>
> Correct `MIGRATION-REHEARSAL-1-READINESS.md`'s "137 carry a legacy id" to "**105
> carry a usable legacy id.**"
>
> The migration treatment is unchanged: assign a new UUID to every tier row; keep
> the legacy id where present in `legacy_collection.fields`; match historical
> contributions to tiers by collection + name + price, not by id (already the
> policy).

**FOUNDER DECISION REQUIRED:** none — documentation correction only.

## 16. Legacy table classification

**FACT — 53 public tables, classified.** (A = live-domain, B = migration.legacy_*
history, C = legacy_overflow, D = legally excluded, E = unresolved.)

| Table | Rows | Class | Notes |
|---|---|---|---|
| `profiles` | 622 | A + B extras | Core to users; extras to `legacy_profile.fields` |
| `admin_users`, `admin_events` | 2 + 71 | C | Staff realm (ADR 0009) not built |
| `user_identity` | 12 | **D** | NIN/BVN ciphertext + hashes + last-4. **L-1 blocks** |
| `kyc_verifications`, `_documents`, `_files`, `_verification_history`, `verification_documents` | 21 + 44 + 53 + 55 + 1 | **D** | L-1/L-2 block; Storage 53 objects excluded by D6 |
| `collections` | 275 | A + B extras | See §§1–15 |
| `contribution_code_counters` | 53 | A | Seeds `collection_code_sequences.next_number` |
| `collection_access_grants`, `_invites`, `_invite_items`, `_transfer_requests` | 0 × 4 | C | Empty legacy shapes |
| `contributions` | 5,576 | B (`legacy_contribution`) | History; codes preserved via `legacy_links` (§11) |
| `deposits` (attributed) | 4,884 | B (`legacy_deposit`) | Immutable, verbatim |
| `deposits` (unattributed) | 1,317 | B (`unattributed_payments`) | Never attributed by design |
| `withdrawals` | 292 | B (`legacy_withdrawal`) | F-M2; `destination_account` refused by new table |
| `wallets` | 245 | **C** | **Never** a balance, opening or live. Preserve as history only |
| `wallets_backup_20260805` | 240 | C | Forensic snapshot |
| `pending_payment_context` | 797 | C | Legacy payment state machine — do not seed `payment_attempts` |
| `payout_accounts` | 26 | **D → C** | `account_number_cipher` (bytea), `account_last4`, `bank_code`. **L-3**: excluded from Rehearsal #1; if imported later, ciphertext-only, `payout_accounts` fields into overflow |
| `transfer_recipients` | 52 | **D → C** | **Plaintext `account_number`.** **L-3**: excluded; if ever imported, redact to `bank_code + last4`. Never carry plaintext forward |
| `settlement_runs` | 56 | C | Nightly job audit |
| `payment_recovery_log` | 30,242 | C | Largest table |
| `payment_admin_actions` | 220 | C | Staff financial interventions |
| `payment_reference_backfill_snapshot_20260811`, `duplicate_void_snapshot_20260812` | 3,324 + 12 | C | Forensic snapshots |
| `campaigns`, `campaign_donations`, `campaign_images` | 1 + 0 + 1 | C | §13 |
| `campuses`, `students` | 46 + 1 | C | Campus directory; not in new product |
| Ambassador × 6 | 2 total | C | Referral programme; `ambassador_profiles.pin_hash` **excluded** — credential |
| `notifications` | 172 | C | New notifications designed, not built |
| `push_subscriptions`, `push_notification_events` | 13 + 173 | C | `push_subscriptions` endpoint keys → **redact** |
| Email × 8 | 4,839 total | C | `email_unsubscribes` (0) compliance-relevant even at 0 rows |
| `password_change_otps`, `password_reset_otps` | 6 + 0 | C | Supabase Auth owns OTPs now; preserve for F-M3 |

**53 tables accounted for. Zero explicitly not-migrated. Two tables' D → C
transition depends on L-3.**

## 17. Founder decisions required

| # | Decision | Rows affected |
|---|---|---|
| **E-COL-1** | `updated_at` as archival proxy for the 12 deleted collections | 12 |
| **D4** | Archive the 2-character-title zero-activity collection | 1 |
| **D6** | Approve "highest-priced tier keeps the shared prefix" | 2 collections, 10 tiers |
| **D7** | Confirm "quantity=0, sold=0, no history → unlimited" | 1 tier |
| **A01** | Free fixed collections OK, or archive them | 2 |
| **A03** | Import ticket collection with no tiers, or archive | 1 |

Six decisions, all with named rows. **None requires a new enum value or a
relaxation of an existing invariant.**

## 18. Engineering decisions ready without founder approval

| # | Decision | Rationale |
|---|---|---|
| F-L4 tier renaming (§3) | Founder-directed no relaxation of unique-name; the transformation is mechanical | The evidence (installment options) determines the rule |
| D5 prefix normalisation (§7) | No live invariant weakened; no historical code depends on the value | Legacy prefix preserved in overflow |
| M7 open/public (§10) | Absence of a private-collection surface | Inference of last resort but unambiguous |
| A-1 contributor codes → `legacy_links` (§11) | Runbook already specified this; evidence confirms the need | The importer implements it |
| A-4 nulled in live, preserved in overflow (§12) | Copying URLs to a project about to be disconnected is worse than nulling; base64 has no home in a live column | — |
| F-L2 campaigns → overflow (§13) | The row shape and one-row population close it | — |
| E-COL-2 → dissolved (§5) | The evidence proves this is a rejected campaign, not a collection | — |
| Slug normalisation removed | Every legacy slug already fits the destination format | — |
| Tier ID doc correction to 105 / 200 (§15) | Measured — documentation catch-up | — |
| A02 (§14) | F-L3 already directs this | — |

Ten items. The importer can be written against every one.

## 19. Legal decisions still outstanding

| # | Question | Effect on Rehearsal #1 |
|---|---|---|
| **L-1** | May `user_identity` and KYC (12 + 174 rows) be migrated at all? | **Excluded** from Rehearsal #1; no change |
| **L-2** | Retention of 53 KYC documents | Excluded — Storage is out of scope |
| **L-3** | Bank details — `payout_accounts` ciphertext (26) and `transfer_recipients` plaintext (52) | Excluded from Rehearsal #1. If imported later: `payout_accounts` → overflow with ciphertext only; `transfer_recipients` → **redact to bank_code + last4**, drop `account_number` |

All three keep the same posture. None blocks Rehearsal #1 if the excluded tables
are recorded as excluded in the run's `notes`.

## 20. Exact next importer requirements

The Import Foundations milestone already added the migration schema tables, the
importer role for `migration.*`, the auth import context, and TRUNCATE guards. To
build the importer:

1. **Grants and RLS on the public destinations** (`users`, `communities`, `officer_terms`,
   `collections`, `members`, `collection_tiers`, `collection_fields`,
   `collection_code_sequences`, `legacy_links`), following the proposed matrix in
   [IMPORT-FOUNDATIONS-REPORT.md §5](../IMPORT-FOUNDATIONS-REPORT.md).
2. **The transform functions**, following each `RECOMMENDATION` in this document
   verbatim.
3. **A synthetic fixture set** at production volume (Rehearsal ladder stage 2).
4. **Reconciliation queries** encoding the validation contract (already specified).
5. **An isolated local rehearsal target** — not the development database.

**Not required:** any founder decision beyond §17, any legal ruling beyond §19,
any change to the migration foundation. The foundation is stable.

## Final status

| | |
|---|---|
| Foundation | complete (89 migrations, all suites green) |
| Importer | **not built** |
| Data imported | **none** |
| Migration Rehearsal #1 | **not started** |
| D2 restore | unchanged (275 collections, 5,576 contributions, 292 withdrawals) |
| Local development database | unchanged |
| Staging | untouched (79 migrations) |
| Legacy Supabase | untouched |
| Paystack | untouched |
| Real money moved | none |

**MIGRATION DECISION EVIDENCE COMPLETE — AWAITING FOUNDER APPROVAL** on the six items in §17.

Everything else is engineering-ready.
