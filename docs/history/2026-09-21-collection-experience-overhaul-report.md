# Kolekto — Collection Experience Overhaul: Report

Second pass over the collection creation experience, completing the gaps the
first pass left explicitly open. Companion to
[`2026-09-21-collection-creation-audit-and-architecture.md`](2026-09-21-collection-creation-audit-and-architecture.md)
(audit, legacy comparison, architecture) and
[`2026-09-21-collection-creation-final-report.md`](2026-09-21-collection-creation-final-report.md)
(first-pass completion report).

## Current state

Before this pass, at `dbe5284`:

- Phase 1–3 complete: schema, migration compatibility, application
  foundation, collections, obligations, contributor experience.
- M7 (public contributor identification, "find yourself on the list") was
  committed at `e1ea63c` and complete. Preserved untouched.
- First pass (`c0ec9a7`) had already delivered: cover image inside the
  creation wizard, item images, ticket baskets (several ticket types with a
  quantity each), optional attendee names, fundraiser story fields,
  invitation group selection, and a fix for a regression it had itself
  introduced (`audience_mode` dropped from `app.get_public_collection`).
- Working tree clean. No uncommitted work. Local database intact, never
  reset.

Known limitations recorded at that point, and closed by this pass: item
orders held one item only; tiers and items could not be reordered; attendee
fields were numbered generically; public pages did not differ enough per
type.

## Legacy review

Already documented in the audit doc §2 and not repeated here. The one idea
carried further in this pass is the legacy wizard's treatment of an order as
lines rather than a single choice — which the item basket below now
implements.

## Product audit

Gaps this pass found and closed:

| Area | Was | Now |
|---|---|---|
| Item order | One item + quantity | Basket of items, each with its own quantity |
| Tier/item order | Whatever order rows were added in | Up/down controls, persisted as `sort_order` |
| Attendee fields | "Ticket 1, 2, 3" | "VIP — attendee 1", "Regular — attendee 1" |
| Public page framing | Same layout, different labels | One sentence in each type's own vocabulary |
| Recurring on public page | Indistinguishable from one-off | `schedule` exposed; reads as a recurring charge |

## Architecture

**Shared**: collection identity, description, audience, deadline,
contributor fields, media, draft/publish lifecycle, authorization,
validation, public rendering primitives, and now the order model.

**Type-specific**: which questions the wizard asks, which editors appear,
and what the public page leads with.

The order model is the notable one. A tier and an item are both "a priced
option with limits", so both resolve through the same shape —
`{id, quantity}[]`, summed server-side, each line checked against its own
row's stock and per-order limit. `resolveTierBasket` and `resolveItemBasket`
are the same function twice over two different row types, not two different
concepts. Single-selection shapes (`tierId`, `itemId` + `quantity`) still
resolve unchanged, so nothing that already worked had to move.

## Collection experiences

- **Fixed** — one amount, asked once. Wizard focuses on amount, audience,
  deadline, questions, flyer. Public page: "One set amount, the same for
  everyone."
- **Open** — contributor chooses. Suggested amounts, minimum, optional
  target. Public page: "Give what you can. You choose the amount."
- **Tiered** — packages. Editor supports add, edit, remove, reorder, limit.
  Public page: "N packages — choose the one that suits you."
- **Items** — a catalog. Per-item image, price, stock, max per order,
  position. Contributor ticks items and sets a quantity on each; the server
  totals the basket. Public page: "An order. N items to choose from, each
  with its own quantity."
- **Ticketing** — an event. Date, venue, ticket types with limits, optional
  attendee details. Contributor may take several types at once. Public page
  leads with the event block.
- **Fundraising** — a campaign. Three guided story fields (what / why /
  impact), target, suggested amounts. Public page leads with the story.
- **Recurring** — dues that repeat. Frequency, interval, start, due period.
  Public page: "A recurring charge. Each period is asked for separately —
  paying one does not settle the next."

## Media

One system for all of it: bucket `collection-covers`, server-only upload
with the service role, type and size validated in the browser and again on
the server, object path chosen by the server and never by the client.
Collection flyer at `<community>/<collection>/<timestamp>.<ext>`, item image
at `<community>/<collection>/items/<timestamp>-<random>.<ext>`. Both
`app.set_collection_cover` and `app.set_collection_items` refuse a URL that
is not an object this collection's own upload produced. Upload, preview,
replace, remove and public rendering all work; a rejected file shows one
sentence and leaves the editor usable.

## Multi-quantity

`{id, quantity}[]` per line, for both tiers and items. Server re-derives
every price from its own rows, sums the lines, and refuses: a fractional or
non-positive quantity, a quantity above that row's `per_order_limit` /
`max_per_order`, a quantity above its remaining `quantity_limit` /
`quantity_available`, an id that is not this collection's, and the same id
twice in one order. The browser's copy of any limit decides nothing.

## Attendees

Implemented, and optional. `collections.collect_attendee_details` is set on
the event step. When on, the public form asks for one name per ticket unit,
labelled by ticket type, and the server checks the count against the tickets
it actually resolved. Nothing is persisted — no contribution is persisted
anywhere in this phase (ADR 0006/0012), and attendee names follow that rule
rather than quietly becoming the first exception.

## Invitation groups

The link decides. `allow_group_choice` opens the choice;
`member_groups.pickable_at_join` decides which groups may ever be offered.
`app.get_public_invite` returns only those, and only when the link allows a
choice. `app.redeem_invite_link` re-checks every submitted id against the
same set — community-scoped, pickable, not archived — and silently drops
anything else. `allow_multi_group` decides whether more than one is kept.

## Public experience

Each type now opens differently: event details first for ticketing, story
first for fundraising, and a single plain sentence naming what the
collection is for everything else. Below that, the contribution form itself
differs by type — radios for one-of-many packages, checkboxes with
quantities for tickets and items, an amount field for open collections.

## Defects fixed

1. **`audience_mode` dropped from `app.get_public_collection`** (first pass,
   fixed in `20260921140000`). Two redefinitions were built from a stale
   copy of the function. Every open collection's public page wrongly gated
   contributors behind "find yourself on the list". Confirmed against a
   fresh production build's rendered HTML, not just a red test. pgTAP now
   guards the column.
2. **Reorder buttons collided with field labels** (this pass, `cf3bc86`).
   An unnamed row's control read "Move item 2 up", which an accessible-name
   lookup for the "Item" field also matched. Unnamed rows now read "Move row
   2 up".
3. **The reported flyer crash** did not reproduce against current code. The
   real defect was discoverability, fixed in the first pass.

## Tests

- pgTAP: 345 passing.
- Domain: 69 passing (+8 this pass, for the item basket).
- Validation: 58 passing.
- Invariants: 4/4.
- typecheck: clean. lint: clean. build: succeeds.
- Browser: journeys added this pass — several items in one order, tier
  reorder reflected on the public page, oversized and non-image item uploads
  refused without breaking the editor, public page at phone width (including
  a no-horizontal-overflow assertion), and a joiner choosing their own group
  from only the groups the link offers. Verified passing this pass: the item
  basket journey, tier reorder, oversized/invalid item image, and phone
  width.

**Honest caveat, unchanged from the first pass**: the full browser suite is
flaky on this machine (4 CPU / 3.7 GB, documented in `kolekto-local-stack`).
Failures present as timeouts at sign-in or community creation, differ run to
run, and are not specific to the code under test. Every defect reported
above was confirmed by an independent method — direct database queries, or a
fresh production build's rendered HTML — never by a red test alone. A single
100%-green run of the whole suite has not been achieved on this machine.

## Persistence

`supabase db reset` never run. Every schema change applied with
`npm run db:migrate` (10 new migrations across both passes). The
pre-existing persistence marker checks intact (`all 10 pieces present`)
after the full migration history. Collections, tiers, items, invitations and
groups created hours apart during this work were queried directly and all
survived.

## Security

Audited and unchanged in shape: item image upload and removal go through the
same `assertMayEditCollection` gate as every other collection edit;
service-role key is server-only; no client-supplied path, id or price is
trusted; item and tier images must be objects this collection's own upload
produced; invitation group ids are re-validated server-side against the
link's own set. For orders, the server validates existence, ownership,
visibility, quantity, per-order limit, stock and price on every line.

## Files

This pass: 3 commits, 14 files. New migration
`20260921150000_public_collection_schedule.sql`. Modified:
`packages/domain/src/contribution.ts` (+ its tests),
`packages/db/src/public-read.ts`, the public collection page, contribute
form and its actions, `TiersEditor.tsx`, `ItemsEditor.tsx`, and the two
browser specs.

## Commits

- `5a56208` — item basket, reorder, attendee labels, per-type public framing.
- `cf3bc86` — reorder button naming fix.
- (First pass: `c0ec9a7`, `dbe5284`.)

## Remaining limitations

- **Draft persistence is still partial.** The draft exists from the cover
  step onward, but tiers, items, event details, recurrence, audience and
  questions are only written on the final "Save as draft". Leaving the
  wizard between those points still loses that portion.
- **No live preview.** The review step lists what was entered; it does not
  render the actual public components. §11's "this is what contributors will
  see" is not met.
- **Ticket sales windows** (`sales start` / `sales end` per ticket type) are
  not implemented. Collection-level `starts_at` / `deadline_at` apply to all
  types.
- **Item visibility toggle** exists in the database (`hidden`) and in
  Settings for published collections, but not as a per-item control in the
  editor itself.
- **The browser suite is not fully green on this machine** — see the caveat
  under Tests.

## Next milestone

Close the draft-persistence gap (write each wizard step as it completes,
rather than batching at the end), then Phase 4 (payments) per the existing
roadmap. Not started here.
