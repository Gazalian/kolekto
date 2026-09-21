# Kolekto — Collection Creation Experience Milestone: Final Report

Companion to [`2026-09-21-collection-creation-audit-and-architecture.md`](2026-09-21-collection-creation-audit-and-architecture.md),
which covers the audit, legacy comparison and architecture decisions in full
detail. This is the completion report requested at the end of that milestone
brief.

## 1. Executive summary

Investigated, audited, designed and implemented the collection creation
experience gaps described in the brief. Most of the hard, security-sensitive
backend work for these features (ticket quantity limits, invitation group
selection, item images) already existed in the database from Phase 3's first
migrations and was simply never wired through the application layer — this
milestone mostly completes that wiring rather than inventing new
architecture. Found and fixed one real regression introduced by my own
migration work along the way. Committed as `c0ec9a7` on `main` (this repo's
established convention — every prior phase commits directly to main, no PR
workflow in evidence).

## 2. What was wrong

- **Flyer discoverability** (the concrete complaint): confirmed real — cover
  upload only existed in post-creation Settings, never in the wizard. The
  "crash on upload" itself did **not** reproduce against current code
  (`e1ea63c`); the working, tested upload path was already correct. Most
  likely hit against an earlier commit, or a local-stack stall that looked
  like a crash.
- **Item images**: `collection_items.image_url` column existed since day
  one, never written to or displayed anywhere.
- **Ticket/tier quantity**: `collection_tiers.quantity_limit` /
  `per_order_limit` / `code_prefix` columns existed since the first
  collections migration (explicit comment: "quantity-limited tiers... an
  optional per-tier prefix"), never read by the domain layer or exposed in
  the UI. A contributor could pick exactly one tier, quantity always one.
- **Invitation group selection**: `invite_links.group_ids` /
  `allow_group_choice` / `allow_multi_group` and
  `member_groups.pickable_at_join` existed with fully correct, already-tested
  server-side validation. No UI anywhere used any of it.
- **Fundraising**: literally "open amount + description + target field" —
  the exact shape the brief criticized, verbatim.
- **Creation IA "all looks the same"**: partially true. The wizard already
  had a type-picker with distinct copy per intent and progressive
  disclosure; it was not a flat generic form. What was missing is addressed
  below.

## 3. Legacy code reviewed

`kolekto-fe-old/src/components/collections/wizard/` — full detail in the
audit doc. Reused: the three-question fundraising story structure
(what/why/impact), the insight that a ticket type is a tier with a quantity.
Rejected: client-side image storage, fee-preview UI (Phase 4), QR/unique-ID
generation (fulfillment, out of scope).

## 4. Collection creation architecture

Did **not** rebuild the wizard from scratch — it already implements most of
what was asked (intent picker → progressive disclosure, no `collection_type`
column, ADR 0013 respected). Extended it:

- New Cover-image step between Contribution and Who-pays; the draft is now
  created one step earlier so the uploader has something real to attach to.
- Fundraiser intent gets a `StoryEditor` (three guided fields) instead of
  the generic description+target.
- Ticketing keeps `amountModel: "tiers"` (not moved to `items` — a bigger,
  riskier change for no benefit since tiers already carry the right
  columns).

## 5. Per-collection experience

- **Fixed / Open Amount / Tiered**: unchanged behaviourally, now with a
  flyer step.
- **Items**: items now carry images, uploaded via the same pattern as the
  flyer.
- **Ticketing**: multi-ticket-type-with-quantity basket
  (`VIP × 2, Regular × 1`), optional per-ticket attendee names.
- **Fundraising**: story-first creation and public page, three guided
  prompts.
- **Recurring**: unchanged (already clear it's not automated payment).

## 6. Media system

Flyer and item images share one bucket (`collection-covers`), one
server-only upload path, one validation shape (JPG/PNG/WebP, 5MB). Item
images live at `<community>/<collection>/items/<timestamp>-<random>.<ext>`.
Both `set_collection_cover` and `set_collection_items` enforce that an
`image_url` must be an object this collection's own upload path produced
(SEC-18) — the items check is new, added in this milestone.

## 7. Quantity/order model

`resolveContributionAmount`'s `tiers` case gained a basket form
(`tierSelections: {tierId, quantity}[]`) alongside the untouched single-
`tierId` shape. Each line is checked against that tier's own
`quantity_limit`/`per_order_limit`, summed server-side. Plain "choose one"
tiered collections are unaffected — same radio UI, same single-tier
resolution path, zero behavior change.

## 8. Attendee model

Optional per-event toggle (`collections.collect_attendee_details`). When on,
the public form asks for one name per ticket unit in the order, validated
against the server-resolved ticket count. Not persisted anywhere — the whole
contribution flow is a stateless preview in this phase (ADR 0006/0012), and
attendee names follow that same rule.

## 9. Invitation group selection

`app.get_public_invite` now returns the pickable groups a link's
`allow_group_choice` unlocks (empty when the link doesn't offer a choice).
The join page renders checkboxes/radio depending on `allow_multi_group`.
Server-side validation (community-scoped, pickable-only, archived-excluded)
already existed and is unchanged — this was pure UI wiring plus one
read-function extension.

## 10. Public experience

Fundraiser pages now show story before the amount block. Event pages
already showed event details before the generic description. Full per-type
reordering of the whole page (§25's broader ask) was not attempted —
flagged as a known limitation below.

## 11. Tests — exact counts

- **pgTAP**: 345 passing (was 337 before this milestone), all in
  `supabase/tests/`.
- **Domain**: 61 passing (`packages/domain`), including 7 new tests for the
  ticket basket.
- **Validation**: 58 passing (`packages/validation`), including 8 new tests
  for item images, event attendee flag, fundraiser story.
- **Invariants**: all 4 hold (money-is-kobo, RLS-on-every-table,
  no-money-writes-outside-db, one-Paystack-caller).
- **typecheck**: clean, zero errors.
- **lint**: clean (found and fixed 3 real `react/no-unescaped-entities`
  errors in `InviteLinkDialog.tsx` along the way).
- **build**: `next build` succeeds (production bundle).
- **Browser (Playwright)**: added/extended journeys for flyer-in-wizard,
  invalid-image, item images, multi-ticket-with-attendees, fundraiser
  story. **Not fully green** — see §13.

## 12. Security audit

- Item image upload/removal: server-only, service-role, ownership-checked
  via the same `assertMayEditCollection` gate every other collection edit
  uses — no new auth surface.
- `set_collection_items`'s new URL constraint closes a real gap: before this
  milestone, an officer with `collection.draft` on one collection could have
  pointed an item's `image_url` at any object in the bucket, including
  another collection's.
- Invitation group redemption: no changes to the write path — it was
  already correct (community-scoped, pickable-only, archived-excluded,
  SEC-18-compliant).
- No service-role key reaches the browser in any new code; verified by
  pattern-matching against the existing `collection-cover.ts` shape.

## 13. Persistence verification

- Never ran `db reset`. Used `db:migrate` for every schema change (9 new
  migrations).
- Pre-existing persistence marker checked intact (`all 10 pieces present`)
  after this session's full migration history.
- Manually verified via direct DB queries mid-session that collections,
  tiers and invitations created hours apart all survived correctly.
- Full pgTAP suite (345 tests) green against the current schema state.

**Browser-test caveat, stated plainly**: after several hours of sustained
build/test/migration activity on this machine's documented 4-CPU/3.7GB local
stack, the Playwright suite was flaky — timeouts at unrelated points
(community creation, OTP sign-in) rather than deterministic assertion
failures, and different tests failed on different runs. I did not treat "the
test went red" as ground truth by itself: every real defect reported below
was confirmed by an independent method (direct DB queries, or a fresh
production build's rendered HTML), not by the flaky suite alone. I did not
get a single 100%-green run of the full browser suite on this machine.

## 14. Defects found and fixed

**The flyer "crash"**: did not reproduce against current code. Root cause
could not be identified because the bug wasn't present in this codebase
state — most likely environmental (documented Kong/OTP stack flakiness) or
from an earlier commit. The real, still-present defect was discoverability,
which is fixed.

**A regression introduced during this milestone**: two of the new migrations
(`20260921120000`, `20260921130000`) redefined `app.get_public_collection`
from an outdated copy of the function that predated `audience_mode` being
added to it, silently dropping that column. Every open/public collection's
contribution page started treating `audience_mode` as `undefined` (≠
`'public'`) and wrongly gated every contributor behind "find yourself on the
list." Caught by this milestone's own e2e suite; confirmed — not assumed —
by building a fresh production bundle and inspecting rendered HTML directly,
since the local stack's flakiness made a single failing test insufficient
evidence on its own. Fixed in `20260921140000`; the two source migrations
were also corrected in place (uncommitted local files, never shared
elsewhere) so a fresh database build never reintroduces it. A pgTAP
regression test now covers `get_public_collection`'s `audience_mode` output
— the coverage gap that let this through in the first place.

## 15. Known limitations

- **Item multi-basket**: items still support exactly one item + quantity per
  order, not a full cart of several different items in one order (§16's "if
  multiple items are selected" case). The ticket basket abstraction
  generalises cleanly to items but wiring it through was out of scope for
  this pass; flagging rather than quietly shipping partial.
- **Attendee-name-to-ticket-type labeling**: the attendee name fields are
  numbered sequentially ("Ticket 1, 2, 3…"), not labeled by which tier they
  belong to ("VIP ticket 1"). Functionally complete, cosmetically rougher
  than ideal.
- **Full public-page reordering per type** (§25): only fundraiser
  story-placement was done. Items-first for item collections and full page
  restructuring per type was not attempted.
- **Progressive draft persistence** (§23): the draft now persists from the
  Cover step onward (an improvement over before), but tiers, items, event,
  recurrence, audience and questions are still only saved on the final "Save
  as draft" click — a browser crash between Cover and Review still loses
  that portion of the work.
- **Browser test suite is not fully green** on this machine, for the reasons
  in §13.

## 16. Files created/modified

9 new migrations, 2 new components (`StoryEditor.tsx`, `item-image.ts`), 1
audit/architecture doc (plus this report), 22 modified files across
`apps/web`, `packages/domain`, `packages/db`, `packages/validation`, and the
test suites. Full list in the commit (`c0ec9a7`, 32 files, +2475/−58).

New migrations, in order:

1. `20260921100000_invite_pickable_groups.sql`
2. `20260921110000_collection_item_image_validation.sql`
3. `20260921120000_collection_attendee_details.sql`
4. `20260921130000_fundraising_story.sql`
5. `20260921140000_fix_public_collection_audience_mode_regression.sql`

## 17. Commit hash

`c0ec9a7` on `main`.

## 18. Next recommended milestone

Complete the item multi-basket (extend the same `tierSelections`-style
basket to items), then Phase 4 (payments) per the existing roadmap — not
started here per explicit instruction.
