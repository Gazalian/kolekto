# Collection creation experience — audit, legacy comparison, architecture

2026-09-21. Scope: the milestone brief asking for a purpose-built creation
experience per collection type, working flyer/item images, a quantity/order
model for tickets and items, fundraising specifically, and invitation group
selection. Phase boundary unchanged: nothing here touches Paystack, ledger,
withdrawals or M8 obligations workflow (ADR 0006, ADR 0012).

## 1. What was actually wrong — verified against the live code, not memory

The brief describes a flyer upload that "broke the whole site". I reproduced
the current flyer path end-to-end (`npx playwright test collection-types.spec.ts
-g flyer`) against the running local stack before changing anything: it
**passes** — upload, public display, replace, remove, mobile all work. Reading
`CoverUploader.tsx`, `lib/collection-cover.ts`, the `set_collection_cover`
migrations and the storage bucket policy shows a correctly-built feature:
server-only service-role upload, path-scoped removal, a URL constraint tying a
flyer to its own collection's storage folder. Whatever produced the crash the
user saw is not present in the code as it stands today (`e1ea63c`) — most
likely it was hit against an earlier commit, or a stack hiccup ([[kolekto-local-stack]]
already documents Kong stalling under load, which can look like "the whole
site broke" from a browser). **The complaint that is still real**: the
uploader only exists in `SettingsPanel.tsx`, reachable after a collection is
created. There is no flyer step in `NewCollectionForm.tsx`. That is the actual
defect — discoverability, not a crash — and it is fixed below (§3).

The rest of the brief's complaints check out:

- **Item images**: `ItemsEditor.tsx` and `collection_items` have no image
  column at all.
- **Ticket/item quantity**: `collection_tiers` already has `quantity_limit`,
  `per_order_limit` and `code_prefix` columns (migration `20260917120700`,
  comment: *"COL-13: quantity-limited tiers… CODE-02: an optional per-tier
  prefix, so a code reads DIN26-VIP-0042"*) and `packages/validation`'s
  `tierSchema` already validates them. **None of it is wired through** —
  `ContributionTier` (domain), `getPublicCollectionTiers` → `ContributeForm`
  never read or send a quantity, and a contributor can select exactly one
  tier. This was provisioned for tickets on day one and never finished.
- **Invitation group selection**: `invite_links.group_ids`,
  `allow_group_choice`, `allow_multi_group`, and `member_groups.pickable_at_join`
  already exist, and `app.redeem_invite_link` already validates a submitted
  group id server-side (community-scoped, pickable-only, archived groups
  excluded) — this is the exact security shape the brief asks for. **Nothing
  in the UI uses it**: `get_public_invite` doesn't return the pickable group
  list, `JoinForm.tsx` has no checkboxes, and `InviteLinkDialog.tsx` never
  offers `allowGroupChoice`/`allowMultiGroup`. Same pattern as tickets: the
  hard, security-sensitive part was already built; the UI was never finished.
- **Creation IA "all looks the same"**: partially true, partially not.
  `NewCollectionForm.tsx` already has a type-picker step ("Dues or a levy",
  "A charge that repeats", "Tickets for an event", "Fundraiser", …) with
  distinct copy and a `collects` flag set that shows/hides `EventEditor`,
  `RecurrenceEditor`, `SuggestedAmountsEditor` per type — it is not one flat
  form. What is genuinely missing: fundraising has no story/cause fields at
  all (it is literally "open amount + target", matching the brief's own
  complaint verbatim); ticketing borrows tier vocabulary ("option") instead of
  ticket vocabulary; there is no cover-image step.

## 2. Legacy code reviewed (`kolekto-fe-old`)

`src/components/collections/wizard/` — a 6-step wizard (`Step1TypeSelection`
→ `Step2BasicInfo` → `Step3Pricing` → `Step4Charges` → `Step5ContributorFields`
→ `Step6UniqueId` → `ReviewStep`), plus three fundraising-only steps
(`FundraisingGoalStep`, `FundraisingStoryStep`, `FundraisingVerificationStep`).

| Area | What it did | Reused | Rejected |
|---|---|---|---|
| Type selection | Cards with per-type feature bullets, a color per type, a review banner | The idea that the type step should sell the type, not just name it — but the new codebase's existing `INTENTS` array already does this in prose form | Color-per-type as a load-bearing signal — this codebase's design system doesn't hang meaning on color |
| Fundraising goal | Open-ended checkbox, target amount, deadline, "auto-close" toggle, a fee-preview box | Open-ended vs targeted as the first fundraising decision; deadline as optional | Auto-close (needs payment infra to mean anything — ADR 0006 gates it); the fee-preview box (fees are Phase 4) |
| Fundraising story | Three prompts — "what is this for", "why does this matter", "what impact will donations have" — plus up to 5 gallery images | The three-prompt structure, because it is genuinely better than one description textarea and matches what makes a campaign read as a campaign | Client-side `FileReader`/base64 image storage — the new codebase already has a correct server-side upload path (`collection-covers`), reused rather than reinvented |
| Ticket pricing | Fixed-price or tiered-price toggle; tiers reused verbatim as ticket types; a checkbox "allow multiple tickets per purchase — each gets its own unique ID & QR code" | **The core insight**: a ticket type *is* a tier with a quantity. The new codebase's `collection_tiers.quantity_limit`/`per_order_limit` already encode exactly this — nothing new to build, only wire up (§5) | QR codes and unique-ID generation — that's a fulfillment/redemption feature past this milestone's boundary, not creation |
| Item/order | Not present as a distinct legacy flow — items are new to this codebase | — | — |

The legacy `CreateCollectionForm.tsx` is explicitly documented as dead in
`kolekto-fe-old/CLAUDE.md` ("the live path is the wizard") — not read.

## 3. Architecture: what changes and what does not

**Not rebuilt**: the "intent picker → progressive-disclosure steps" shape in
`NewCollectionForm.tsx`. It already does most of what §11/§12 of the brief
asks (one question per screen, nothing shown until relevant, no
`collection_type` column — ADR 0013 stands). Discarding it to build seven
fully separate flows would cost far more than it returns and would regress a
tested, working creation path — the brief's own §33 forbids exactly that.

**What changes**:

1. A **cover-image step** is added to the wizard (between "Details" and
   "Contribution"), backed by the *existing* `CoverUploader` server actions —
   draft-first: the collection is created as a draft the moment step 1
   completes, then the flyer step uploads directly against that draft's id,
   same as settings does today. No dead time waiting for "review" to attach an
   image.
2. **Fundraiser** gets its own contribution-step content: cause/story prompt
   (reusing the legacy three-question shape, collapsed to one guided textarea
   set — "what for / why it matters / what it funds" — see §7), replacing the
   generic "target" field reuse.
3. **Ticketing** ("Tickets for an event" intent) keeps `amountModel: "tiers"`
   (not moved to `items` — that would be a bigger, riskier change for no
   product benefit, since tiers already carry the right columns) but:
   - `TiersEditor` gains an optional **quantity mode** switch, shown only for
     the `event` intent: "one ticket per order" (today's behaviour, quantity
     locked to 1) or "people can buy more than one" (turns on
     `perOrderLimit`/`quantityLimit` inputs already in the schema, and lets a
     contributor select **several ticket types with a quantity each** in one
     order — the "VIP × 2, Regular × 1" case).
   - The event step gains a **"collect attendee details"** toggle. When on,
     the public form asks for one name (and optional phone) per ticket unit
     in the order; when off, only the buyer's own contact is asked. Nothing
     is persisted beyond what the whole contribution flow already does today
     (a computed, unstored preview — ADR 0012's boundary is unmoved; ticket
     attendee names are not contributions, contact records, or money, and
     inventing a table to hold them now would be building ahead of a decision
     that hasn't been made).
4. **Items** gets per-item images, using the exact same storage-bucket
   pattern as the collection cover (new bucket, same server-only
   upload/validate/remove shape).
5. **The order/line-item abstraction** (brief §3/§17): generalising
   `resolveContributionAmount`'s `tiers` case from "exactly one tier, quantity
   always one" to "one or more `{tierId, quantity}` lines, summed, each
   checked against that tier's own `quantity_limit`/`per_order_limit`". This
   is additive to the domain module — `items` already had this shape for a
   single item; tiers gain the same shape. No new concept, no new table.
6. **Invitation group selection**: `app.get_public_invite` gains one more
   returned column — the community's `pickable_at_join` groups this specific
   link's `allow_group_choice` unlocks, by id and name — and the join page
   renders them as checkboxes (radio when `allow_multi_group` is false).
   `redeemInviteLinkAction` already threads `groupIds` through; it only needed
   a form that sends them. `InviteLinkDialog` gains the two checkboxes
   (`allowGroupChoice`, `allowMultiGroup`) the create function has accepted
   since 2026-09-20 and the dialog never exposed.
7. **Public page differentiation** (§25): the public collection page
   (`app/[communitySlug]/[collectionSlug]/page.tsx`) reorders its header block
   by category — event details before the amount block for `category =
   'event'`, the fundraising story before the amount block for `category =
   'fundraiser'` — rather than the same fixed order for every type.

## 4. Product audit matrix

| Type | Current creation | Missing (before this milestone) | Legacy reference | Backend support | Public experience | Tests |
|---|---|---|---|---|---|---|
| Fixed (dues) | Intent → amount → audience → questions | Cover image only reachable post-creation | Step3Pricing `FixedPricing` | Full | Amount-first, correct | `collections.spec.ts` |
| Recurring | Intent → amount → `RecurrenceEditor` | Same as Fixed | — (legacy had no recurring) | Full | Amount + cycle | `collection-types.spec.ts` |
| Open amount | Intent → min/max/suggested | Cover image | `OpenPoolPricing` | Full | Amount-first | `collections.spec.ts` |
| Tiered | Intent → `TiersEditor` | Cover image | `TieredPricing` | Full | Options-first | `collections.spec.ts` |
| Items | Intent → `ItemsEditor` | Cover image; **item images**; **multi-item basket** (single item + qty only) | none in legacy | Domain done for 1 item; needs basket | Items-first | `collection-types.spec.ts` |
| Ticketing | Intent → `TiersEditor` (as ticket types) → `EventEditor` | Cover image; **multi-ticket-type + qty basket**; **attendee details** | `TicketPricing`, "allow multiple tickets" checkbox | `quantity_limit`/`per_order_limit` columns exist, unused above the DB | Options-first (should be event-first) | `collection-types.spec.ts` |
| Fundraising | Intent → open-amount + target | **No story/cause fields at all**; cover image | `FundraisingGoalStep`, `FundraisingStoryStep` | Full for amount; no story columns | Amount-first (should be story-first) | none dedicated |

Cross-cutting: flyer/image (creation-time gap only), quantity (tickets/items
gap), multi-item selection (gap), attendee information (absent), suggested
amounts (done, open-amount + fundraiser), target (done), deadline (done),
audience (done, `AudiencePicker`), custom fields (done, `QuestionsEditor`),
preview (review step exists but is a data dump, not a rendered preview —
left as a known limitation, see final report), public page (works, not yet
type-ordered), validation (done per-field, gains new fields below), storage
(done for cover, extended for items), mobile (Tailwind responsive throughout,
unchanged).

## 5a. A regression this milestone introduced and caught

While wiring the fundraiser story and attendee-details columns into
`app.get_public_collection` (a function whose return type cannot be altered
in place, so every change to it is a `drop function` + full redefinition),
two of the three redefinitions in this milestone (`20260921120000`,
`20260921130000`) were built from a copy of the function that predated
`20260920170100` — the migration that had added `audience_mode` to it so the
public page could tell an open collection from a managed one. Both
redefinitions silently dropped that column from the function's shape.
Postgres accepts a function redefined with a different return signature
without complaint, so nothing failed at migration time. The effect: every
open/public collection's contribution page started reading `audience_mode`
as `undefined`, which is not `'public'`, and sent every contributor through
"find yourself on the list" — a gate meant only for named-member
collections — ahead of a form that should have asked for a contribution
directly. It affected every collection type this milestone touched (tiered,
items, fundraiser) and was **not** specific to the new ticket-basket UI,
which is where it first surfaced in testing.

Found by this milestone's own Playwright suite failing consistently on
public-page assertions; confirmed (not assumed) by building a fresh
production bundle and inspecting the rendered HTML directly, since the local
stack's own flakiness ([[kolekto-local-stack]]) made a single red test
insufficient evidence on its own. Fixed in `20260921140000`, and the two
source migrations were also corrected in place (uncommitted local files,
never shared) so a fresh database build never reintroduces it. A pgTAP
regression test now asserts `app.get_public_collection` returns the correct
`audience_mode` — the coverage gap that let this through in the first place.

## 5b. Why tiers, not a new "tickets" table

`collection_tiers` was built with `quantity_limit`, `per_order_limit` and
`code_prefix` in the very first collections migration, before ticketing was
mentioned anywhere else in this codebase's history — someone already decided
tickets are tiers with limits. Building a parallel `collection_tickets` table
now would fork behaviour the schema was clearly designed to share, and would
leave the existing columns permanently dead. The generalisation in §3.5 is the
completion of a feature that was already half-built, not a new one.
