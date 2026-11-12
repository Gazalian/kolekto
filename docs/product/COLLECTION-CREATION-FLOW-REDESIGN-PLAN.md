# Collection creation flow — redesign plan

Status: **implemented on branch `feat/collection-creation-redesign`** (2026-11-09), branched from
`m13.2-worker-hardening` at `6e8227f`. The "Observed" sections describe the code *before* this change.

How the open decisions were resolved in the implementation (change any of these by editing the code
named):

| ID | Resolution in code |
|---|---|
| D0 | **Decided 2026-11-10 by product: "the fee can be passed to contributors."** D-17's engineering default is superseded; O-4's legal side remains with counsel and is not a blocker for this change. New collections default to `contributor_pays` (`DEFAULT_FEE_MODE` in `new/NewCollectionForm.tsx`); existing collections and drafts keep their stored value. |
| D0a | Wizard default only; no DB or community default changed. |
| D1 | Up to two decimals allowed (keeps what the schema already accepts); `inputMode="decimal"`. |
| D2 | `k` expands as it is typed: `5k` → `5,000`. |
| D3 | Contributor pay page not changed. |
| D4 | Extras kept as one optional screen; sections not collapsed (both are already one line when unused); button stays "Continue". |
| D5 | Fees stay a separate screen for packages, items, tickets. |
| D6 | Sales close is filled with the event start when empty, with a hint saying so; editable. |
| D7 | Type is locked once a draft exists (Back hidden on Step 1). |
| D8 | Choosing an image before a draft exists creates the draft, then uploads. |
| D9 | Not implemented (no review edit links, stepper not clickable). Sticky mobile footer is implemented. |
| D10 | Hard cap of 15 whole-naira digits per field; no product-level maximum. |

Placement detail: the image control renders after the name **and** description (all three on step 1),
not between them.

Decisions that need product, legal or engineering input are marked **[DECISION]** and collected in §7.

---

## 0. Summary

- The wizard is already flow-driven (M7.7): `apps/web/app/c/[slug]/collections/new/flows.ts` defines seven
  flows as ordered lists of step kinds, and `NewCollectionForm.tsx` renders by kind. The problem is not the
  architecture; it is that every flow still walks **8–10 steps** after the type is chosen (the UI shows
  9–11 because it counts the type picker as step 1), several of which hold one optional control.
- Proposed: choosing the collection type becomes a **separate screen before the steps**, not a numbered
  step and not in the progress bar. After it, every flow is **5–6 steps**, by merging steps that answer
  one question together, making optional configuration one skippable step, and moving the image to step 1.
- Three cross-cutting requirements: live thousands separators in amount fields, "Contributor pays" as the
  fee default, image beside title/description.
- **The fee-default decision is recorded.** Product confirmed on 2026-11-10 that the fee may be passed
  to contributors. D-17's engineering default is superseded; the legal half (O-4) stays with counsel
  but is not blocking this change. See §4.2.
- **One pre-existing defect touches stored amounts.** Resuming a draft truncates kobo from every amount
  (`toNairaInput` in `continue/page.tsx:200-203`), and continuing past the step re-saves the truncated
  value. The amount-formatting work must fix this. See §4.1.6.

---

## 1. Inventory — what exists today (observed)

### 1.1 Files

| Concern | File |
|---|---|
| Flow definitions, step kinds, vocabulary, fee preview rows, `flowKeyFor` | `apps/web/app/c/[slug]/collections/new/flows.ts` |
| Wizard renderer, state, per-step persistence | `apps/web/app/c/[slug]/collections/new/NewCollectionForm.tsx` |
| New-collection page (permission gate, member count, groups) | `apps/web/app/c/[slug]/collections/new/page.tsx` |
| Resume a draft | `apps/web/app/c/[slug]/collections/[collectionSlug]/continue/page.tsx` |
| Review screen | `apps/web/app/c/[slug]/collections/new/ReviewPanel.tsx` |
| Fee control (only fee UI in the product) | `apps/web/app/c/[slug]/collections/FeeConfigurator.tsx` |
| Image upload | `apps/web/app/c/[slug]/collections/CoverUploader.tsx` |
| Editors | `TiersEditor.tsx`, `ItemsEditor.tsx`, `SuggestedAmountsEditor.tsx`, `EventEditor.tsx`, `StoryEditor.tsx`, `RecurrenceEditor.tsx`, `AudiencePicker.tsx`, `QuestionsEditor.tsx` (same folder) |
| Server actions | `apps/web/app/c/[slug]/collections/actions.ts` |
| Amount validation | `packages/validation/src/collection.ts:55-68` (`NAIRA_PATTERN`, `nairaAmountSchema`) |
| Naira → kobo | `packages/domain/src/money.ts:80-99` (`fromNaira`), display `formatNaira` `:102-114` |
| Text input | `packages/ui/src/components/Field.tsx` (`TextField`, forwards ref) |
| Tests | `new/flows.test.ts` (unit), `tests/e2e/helpers/wizard.ts` (flow-driven walker), `tests/e2e/collection-creation.spec.ts`, `tests/e2e/collection-types.spec.ts`, `tests/e2e/audience.spec.ts` |

### 1.2 Shared mechanics (observed)

- **No type column.** A flow is a preset over `category`, `participationMode`, `amountModel`, `schedule`
  (ADR 0013). `flowKeyFor` derives the flow back from those axes on resume (`flows.ts:485-497`).
- **Step 0 is the type picker** (`PURPOSE_STEP`, `NewCollectionForm.tsx:76-80`). It is counted in the
  progress text ("Step 1 of 10 · Purpose").
- **The draft row is created on the first Continue** (`advance` → `persistStep` → `saveCollectionRow`),
  or earlier on name blur for the event and story steps (`ensureDraft`, `:315-325`).
- **Every step saves on Continue** (`persistStep`, `:358-513`) and the step index is stored in
  `collections.draft_step` (`rememberStepAction`, smallint 0–20, `supabase/migrations/20260921190000_draft_step.sql`).
- **Resume** reads rows back and clamps `draft_step` to the flow's length (`continue/page.tsx`, `NewCollectionForm.tsx:152`).
- **Continue gating** (`canContinue`, `:206-225`) only checks: name ≥ 3 chars; event start present;
  fixed amount non-empty; every tier/item has a name and price; reference prefix ≥ 2 when enabled. It does
  **not** check that amounts are valid, that min ≤ max, or that tier/item names are unique — those fail on
  the server and surface as a single banner (`parsed.error.issues[0]`).
- **Back** is always allowed down to step 0, including after a draft exists (`:1069-1076`). Picking a
  different type then (`chooseFlow`) changes the axes the next save writes; tiers/items rows from the
  previous type are not removed. **[DECISION D7]**
- **Audience must save before the collection row** (`:370-386`) because of the
  `collections_audience_matches_participation` constraint. Any merged step containing audience must keep
  that order.
- **Visibility** (`public` / `unlisted`, default `unlisted`) is on the audience step for every flow except
  Items, where it is on the order-rules step (`:917`, `:814-826`).
- **References step** is info-only for anyone without `collection.configure_codes` (`:949-953`) — a whole
  screen with no control for a treasurer.
- **Review** (`ReviewPanel.tsx`) shows a type-specific headline card plus audience, fees, references,
  timing, questions. It has no "edit this" links; the only way back is repeated Back clicks. Amounts are
  printed raw: `₦{amount}` (e.g. `₦50000`, `ReviewPanel.tsx:315`, `:340`).

### 1.3 Steps per flow (observed)

Row 0 is the type picker, which the UI counts today. "Total" shows the UI's count; "Steps after the
picker" is the like-for-like comparison with §3. ★ = has a required field; everything else is optional.

| # | Fixed contribution | Open contribution | Packages | Items | Tickets | Fundraising | Recurring |
|---|---|---|---|---|---|---|---|
| 0 | Purpose | Purpose | Purpose | Purpose | Purpose | Purpose | Purpose |
| 1 | Basics ★ (name, description) | Basics ★ | Basics ★ | Basics ★ | **Event** ★ (name, description, start ★, end, venue, flyer) | **Story** ★ (title, one-liner, what/why/impact, image) | Basics ★ |
| 2 | Amount ★ | Giving (min, max, suggestions ×6, target) | Packages ★ (name, price, description, limit, prefix) | Items ★ (name, price, description, stock, max per order, photo) | Tickets ★ (+ per-order limit) | Goal (target, suggestions, min) | Amount ★ |
| 3 | Fees | Fees | Fees | **Order rules** (explanatory text + visibility only) | **Buying** (one checkbox: name per ticket) | Fees | Schedule (frequency, interval, start, due-after) |
| 4 | **Cover** | **Cover** | **Cover** | Fees | Fees | Audience + visibility | Fees |
| 5 | Audience + visibility | Audience + visibility | Audience + visibility | **Cover** | Audience + visibility | Questions | **Cover** |
| 6 | Questions | Questions | Questions | Audience | Questions | References | Audience + visibility (no public option) |
| 7 | References | References | References | Questions | References | Timing (campaign end) | Questions |
| 8 | Timing (closing date) | Timing (closing date) | Timing (closing date) | References | Timing (sales open/close) | Review | References |
| 9 | Review | Review | Review | Timing (orders open/close) | Review | — | Review |
| 10 | — | — | — | Review | — | — | — |
| **Total (UI count)** | **10** | **10** | **10** | **11** | **10** | **9** | **10** |
| **Steps after the picker** | **9** | **9** | **9** | **10** | **9** | **8** | **9** |

Observed type-specific behaviour:

- **Image placement.** Five flows have a standalone Cover step *after* Fees (position 4–5). Tickets and
  Fundraising embed the image in step 1, but **below** the other fields, and gated on the name being
  blurred first ("Name the event first — the flyer is saved against it", `:673-676`). The uploader needs a
  real collection id (`uploadCoverAction(slug, collectionSlug, collectionId, …)`).
- **Item photos** already work on the Items step because the draft exists by then; the comment in
  `ItemsEditor.tsx:48-54` saying otherwise is stale.
- **Packages** hides the per-order limit (M7.9 §2D); tickets keep it.
- **Recurring** cannot be public (`allowPublic` false, `:909`) and has no timing step.
- **Open** labels "Target" on the Giving step; **Fundraising** asks the same three things (target,
  suggestions, min) in a different order and with donation wording.
- **Fixed/Recurring** label their audience step "Who pays", next to a fee step headed "Who pays the
  fees?" — two different questions with the same words.
- The fee step renders two headings for one question: the step heading "Who pays the fees?" and the
  fieldset legend "Who should cover payment fees?" (`FeeConfigurator.tsx:109`).

### 1.4 Amount fields today (observed)

All are plain `TextField`s holding the raw typed string; none sets `inputMode`, so mobile shows the full
keyboard. Hints/placeholders say "In naira." / "e.g. 20000".

| Field | Where |
|---|---|
| Fixed amount / amount per period | `NewCollectionForm.tsx:725-731` |
| Smallest / largest contribution, target (Open) | `:738-757` |
| Fundraising goal, smallest donation | `:763-775` |
| Suggested amounts (×6) | `SuggestedAmountsEditor.tsx:27-33` |
| Package / ticket price | `TiersEditor.tsx:185-192` |
| Item price | `ItemsEditor.tsx:136-144` |
| Post-creation: fixed, min, max, target, suggestions | `[collectionSlug]/SettingsPanel.tsx:242-252`, `:469` |
| Post-creation: expected amount, waive amount | `[collectionSlug]/ObligationsPanel.tsx:461`, `:591`, `:715` |
| Contributor side (public pay page) | `apps/web/app/[communitySlug]/[collectionSlug]/ContributeForm.tsx:619` (`inputMode="decimal"`) |

What the server already accepts (`NAIRA_PATTERN`): `5000`, `5,000` (strict groups of three), up to two
decimals, optional `₦`, optional `k` suffix (`5k`), max 20 characters, not zero, not negative. `fromNaira`
strips `₦`, spaces and commas before parsing. **So a correctly comma-grouped string already validates and
saves — no server change is needed for formatting.** `1,0000` (wrong grouping) is rejected.

Quantity fields (stock, limits, interval, due-after days) are parsed with `Number(...)` client-side
(`NewCollectionForm.tsx:399-400`, `:468-470`). `Number("1,000")` is `NaN`. They are **not** amounts and
must not be given separators.

### 1.5 Fee default today (observed)

- Wizard state defaults to `community_absorbs` (`NewCollectionForm.tsx:186`).
- `app.create_collection` copies `communities.default_fee_mode` onto the new row; that column defaults to
  `community_absorbs` (`20260917120300_communities.sql:46`, `20260921160100_draft_amount_may_be_missing.sql:157-176`).
- The fee choice is written only when the Fees step is completed (`setCollectionFeeModeAction`,
  `:477-482`) via `app.set_collection_fee_mode`, which no-ops when unchanged and writes an audit event
  `collection.fee_mode_set` (`20260923100000_collection_fee_mode.sql:63-75`).
- Resume maps the stored value back (`continue/page.tsx:173`). A draft abandoned before the Fees step
  therefore shows the community default, not a choice the organiser made.
- `fee_mode` is configuration only; Phase 4 freezes the bearer onto each payment attempt at creation
  (D-16). Changing the default does not change any stored payment, fee or ledger row.
- The selected option is already visually distinct (2px primary border, `FeeConfigurator.tsx:112-116`).

---

## 2. Design principles for the new flows (recommended)

1. **Identity first.** Step 1 is always: what is it called, what is it, what does it look like (image).
   For an event that also means when and where; for a fundraiser, the story.
2. **Money in one place.** The price(s) and who bears the fees sit together or adjacently, because the fee
   preview is meaningless without the price.
3. **One "who and when" step.** Audience, visibility and dates answer "who can pay, and until when".
4. **Optional configuration is one optional step.** Extra questions and contributor references are
   advanced, rarely needed at creation, and both editable later in Settings. One screen, collapsed,
   Continue works with nothing filled in.
5. **Never show a screen with no decision on it.** Info-only screens (references without permission,
   order rules) are removed or folded.
6. **Same machinery.** Keep flow-as-list-of-kinds, the same editors, the same server actions and
   per-step save. This is a re-composition, not a rewrite, and it needs **no database migration**.

---

## 3. Proposed flows (recommended)

New/merged step kinds (each is a composition of existing editors):

| New kind | Contains (existing pieces) | Replaces |
|---|---|---|
| `details` | name, description, **image** | `basics` + `cover` |
| `event` *(kept, reordered)* | name, **flyer**, description, start, end, venue | `event` |
| `story` *(kept, reordered)* | title, **image**, one-liner, what/why/impact | `story` |
| `price` | single amount (+ schedule for recurring) + `FeeConfigurator` | `amount` + `fees` (+ `schedule`) |
| `giving` | min, max, suggestions, target + `FeeConfigurator` | `openAmount` + `fees` |
| `goal` *(extended)* | target, suggestions, min + `FeeConfigurator` | `goal` + `fees` |
| `tickets` *(extended)* | ticket types + "ask for a name per ticket" | `tickets` + `purchaseRules` |
| `items` *(extended)* | items (with photos) + the order-rules explanation as hint text | `items` + `orderRules` (visibility moves to `whoWhen`) |
| `fees` *(kept for multi-price flows)* | `FeeConfigurator` with one example per package/ticket/item | `fees` |
| `whoWhen` | audience + group picker, visibility, type-aware dates | `audience` + `timing` (+ visibility from `orderRules`) |
| `extras` | questions + references, each collapsed, both optional | `questions` + `reference` |
| `review` *(extended)* | as today, plus "Edit" link per section | `review` |

**Choosing the type is not a step.** It is a separate screen shown before the steps begin: no "Step x of
y", no progress bar, its own heading ("What are you collecting for?"). Selecting a type opens Step 1 of
that flow. Step counts below exclude it, and are compared against "Steps after the picker" in §1.3.
Detail in §4.5.

### 3.1 Fixed contribution — 9 → 5 steps

| # | Step | Heading | Contents | Change |
|---|---|---|---|---|
| — | Choose type | What are you collecting for? | type picker | separate screen before the steps; not numbered |
| 1 | Details | What are you collecting? | name ★, description, image | **merged** basics + cover |
| 2 | Amount | How much does each person pay? | amount ★ (formatted), fee bearer + example | **merged** amount + fees |
| 3 | Who & when | Who is expected to pay, and until when? | audience, visibility, closing date | **merged** audience + timing |
| 4 | Extras | Anything else? (optional) | questions, references | **merged**, optional |
| 5 | Review | Check this over | headline + summary + edit links | kept, extended |

Rationale: one amount produces one fee example, so the fee decision fits under the amount without
scrolling on a phone. The closing date is optional and conceptually part of "who pays and until when".
Nothing collected today is dropped.

### 3.2 Open contribution — 9 → 5 steps

| # | Step | Contents | Change |
|---|---|---|---|
| — | Choose type | | separate screen before the steps; not numbered |
| 1 | Details | name ★, description, image | merged basics + cover |
| 2 | Giving | min, max, suggestions, target, fee bearer + **one** example | merged openAmount + fees |
| 3 | Who & when | audience, visibility, closing date | merged |
| 4 | Extras | questions, references | merged, optional |
| 5 | Review | | kept |

Rationale: as Fixed. Up to six suggestions would produce six fee cards today (`feePreviewRows`, `flows.ts:462-466`);
on a merged step show one representative example (first suggestion → minimum → ₦10,000 example, the
existing fallback order) with "Show for each amount" to expand. Add inline min ≤ max validation (the DB
already enforces it: `collections_…` check in `20260917120700_collections.sql:89-90`; today the organiser
only finds out from a server error banner).

### 3.3 Packages — 9 → 6 steps

| # | Step | Contents | Change |
|---|---|---|---|
| — | Choose type | | separate screen before the steps; not numbered |
| 1 | Details | name ★, description, image | merged basics + cover |
| 2 | Packages | packages ★ | kept |
| 3 | Fees | fee bearer + one example per package | kept |
| 4 | Who & when | audience, visibility, closing date | merged |
| 5 | Extras | questions, references (package prefixes already on step 2) | merged, optional |
| 6 | Review | | kept |

Rationale for keeping Fees separate: the package editor is already long (five fields per package), and the
fee step shows one breakdown per package because absorbing fees on a ₦2,000 and a ₦90,000 package are
different decisions (`flows.ts:427-439`). Appending that to the package editor makes a very long mobile
screen. **[DECISION D5]** if product prefers merging anyway.

### 3.4 Items — 10 → 6 steps

| # | Step | Contents | Change |
|---|---|---|---|
| — | Choose type | | separate screen before the steps; not numbered |
| 1 | Details | name ★, description, cover image | merged basics + cover |
| 2 | Items | items ★ with photos; order-rules explanation as hint | **merged** items + orderRules text |
| 3 | Fees | one example per item | kept |
| 4 | Who & when | audience, visibility (moved from order rules), order window | merged |
| 5 | Extras | questions, references | merged, optional |
| 6 | Review | | kept |

Rationale: the Order rules step contains no order rule — only a paragraph and the visibility select
(`NewCollectionForm.tsx:808-828`). Its paragraph becomes the Items step hint; visibility joins every other
flow's audience step, removing the special case `!hasStep("orderRules")` (`:917`).

### 3.5 Tickets — 9 → 6 steps

| # | Step | Contents | Change |
|---|---|---|---|
| — | Choose type | | separate screen before the steps; not numbered |
| 1 | The event | name ★, **flyer (directly under the name)**, description, start ★, end, venue | reordered |
| 2 | Tickets | ticket types ★, "Ask for a name per ticket" | **merged** tickets + purchaseRules |
| 3 | Fees | one example per ticket type | kept |
| 4 | Who & when | audience, visibility, sales open/close (with the event-date reminder already at `:1018-1023`) | merged |
| 5 | Extras | questions, references | merged, optional |
| 6 | Review | | kept |

Rationale: the Buying step is one checkbox plus explanation (`:830-854`). It belongs with the ticket types
it applies to. Persistence: the merged step must save tiers, then the event row (`setCollectionEventAction`
carries `collectAttendeeDetails`), matching today's two separate saves.
**[DECISION D6]** whether "sales close" should default to the event start.

### 3.6 Fundraising — 8 → 5 steps

| # | Step | Contents | Change |
|---|---|---|---|
| — | Choose type | | separate screen before the steps; not numbered |
| 1 | The story | title ★, **image (directly under the title)**, one-liner, what/why/impact | reordered |
| 2 | Goal | target, suggestions, min, fee bearer + one example | **merged** goal + fees |
| 3 | Who & when | audience, visibility, campaign end | merged |
| 4 | Extras | questions, references | merged, optional |
| 5 | Review | | kept |

Rationale: the story step already holds the image, but at the bottom after three long text areas, so on a
phone it is below the fold. Moving it under the title meets requirement 4 and matches the review headline.

### 3.7 Recurring — 9 → 5 steps

| # | Step | Contents | Change |
|---|---|---|---|
| — | Choose type | | separate screen before the steps; not numbered |
| 1 | Details | name ★, description, image | merged basics + cover |
| 2 | Amount & schedule | amount per period ★, frequency, every N, first period, due after, fee bearer + example | **merged** amount + schedule + fees |
| 3 | Who's included | audience (no public), visibility | kept (renamed from "Who pays") |
| 4 | Extras | questions, references | merged, optional |
| 5 | Review | | kept |

Rationale: "how much, how often" is one thought for a plan. No timing (unchanged — a plan does not close).
If the combined step proves too long on mobile in testing, split the fee bearer back out; it is the least
coupled part.

### 3.8 Step-count summary

Type picker excluded from every column (it is not a step in either design).

| Flow | Today (steps after picker) | Today (UI shows) | Proposed steps | Steps removed |
|---|---|---|---|---|
| Fixed | 9 | 10 | 5 | 4 |
| Open | 9 | 10 | 5 | 4 |
| Packages | 9 | 10 | 6 | 3 |
| Items | 10 | 11 | 6 | 4 |
| Tickets | 9 | 10 | 6 | 3 |
| Fundraising | 8 | 9 | 5 | 3 |
| Recurring | 9 | 10 | 5 | 4 |

No field collected today is removed from the wizard. Every field remains editable post-creation in
Settings as today.

### 3.9 The `extras` step

- Two collapsed sections: "Ask contributors something extra" (QuestionsEditor) and "Give each
  contributor a reference" (ReferenceStep). Both closed by default; a section opens automatically when
  resuming a draft that already has data in it.
- Continue is labelled **Skip** while both are untouched, **Continue** otherwise.
- Without `collection.configure_codes`, the references section is not rendered; one line says an owner can
  switch references on from Settings. (Today this is a full screen with no control.)
- Persistence order unchanged: fields, then code settings (`:484-509`).
- **[DECISION D4]** whether to drop `extras` from the wizard entirely (both remain in Settings).

---

## 4. Shared UX and behaviour requirements

### 4.1 Amount formatting (requirement 2)

**4.1.1 Component.** One `AmountField` used by every amount field in §1.4 (wizard and organiser
Settings/Obligations). Contributor-side `ContributeForm` is **[DECISION D3]** because it sits on the
payment path.

- Pure, unit-tested functions in `packages/domain/src/money.ts` beside `fromNaira`:
  - `formatAmountInput(raw: string, caret: number): { display: string; caret: number }`
  - `canonicalAmount(display: string): string` — digits and at most one `.`, no commas.
- The React component in `packages/ui` (wraps `TextField`, which already forwards a ref). Domain stays the
  single authority on money text (ADR 0003, `actions.ts:86-93`).

**4.1.2 Typing behaviour.**

| Input | Display |
|---|---|
| `1000` | `1,000` |
| `1234567` | `1,234,567` |
| `0012` | `12` |
| `1234.5` | `1,234.5` (decimals allowed only if D1 says so) |
| `1234.567` | `1,234.56` (third decimal refused) |
| paste `₦1,234,567.89` | `1,234,567.89` |
| paste `1 234 567` | `1,234,567` |
| letters, `-`, second `.` | ignored |
| `5k` | **[DECISION D2]** expand to `5,000` on blur, or refuse `k` |

- Caret: count significant characters (digits and `.`) left of the caret in the raw value, then place the
  caret after the same count in the formatted value. This keeps the caret correct when a comma is
  inserted or removed mid-string.
- Backspace with a comma immediately left of the caret deletes the digit before the comma (not a no-op);
  Delete with a comma immediately right deletes the digit after it.
- Selection replace, cut, undo (browser undo may be imperfect with controlled inputs — accept, but test
  that it never produces an invalid value).
- `type="text"`, `inputMode="numeric"` (or `"decimal"` if D1 allows decimals), `autoComplete="off"`,
  a visible `₦` prefix inside the control, `aria-describedby` hint unchanged.

**4.1.3 State and saving.** Recommended: form state holds the **canonical** string (`"1000"`), the field
displays the formatted one. Reasons: `feePreviewRows` builds labels from the raw string
(`flows.ts:465`), review prints `₦{amount}`, and future code may `Number()` it. Every display site formats
via `formatNaira(fromNaira(x), { decimals: false })`. The server receives the canonical string; it would
also accept the comma form, so neither choice changes what is stored.

**4.1.4 Validation.** Validate on blur and on Continue with the same `nairaAmountSchema` the server uses
(import from `@kolekto/validation`), and show the error **inline** on the field (`TextField` already has
an `error` prop). Add client checks the server/DB already enforce but the wizard does not pre-check:
min ≤ max, amount > 0. Keep server validation as the authority.

**4.1.5 Not amounts.** Stock, limits, per-order max, interval, due-after days, reference digits/start
number: no separators (they go through `Number()`).

**4.1.6 Pre-existing defect to fix in the same change (stored amounts can change).**
`toNairaInput` (`continue/page.tsx:200-203`) returns `Math.trunc(kobo / 100)`. The schema accepts up to
two decimals, so an organiser who saved ₦5,000.50 and later resumes the draft sees `5000`; pressing
Continue on that step re-saves ₦5,000.00. This silently changes a stored amount on a draft. The fix is to
convert kobo back without truncation (whole naira when the kobo part is zero, otherwise two decimals).
Before the fix ships, check how many draft rows have a non-zero kobo remainder in any of
`fixed_amount_kobo`, `min_amount_kobo`, `max_amount_kobo`, `target_amount_kobo`, `suggested_amounts_kobo`,
`collection_tiers.price_kobo`, `collection_items.price_kobo` (read-only query; not run for this plan).
This only affects drafts — resume redirects published collections away (`continue/page.tsx:75`).

### 4.2 Fee payer default (requirement 3)

**Decision recorded 2026-11-10.** Product confirmed that the fee may be passed to contributors; the
engineering default under D-17 is superseded. The legal half (O-4) stays with counsel but does not
block this change, consistent with D-17's own stance that both bearer models are implemented. The
migration that added the fee step and `docs/phase-4/financial-decisions.md` still describe the earlier
default and should be reviewed separately.

Implementation (no migration, no change to existing rows):

1. Wizard state default `contributor_pays` for a **new** collection (`NewCollectionForm.tsx:186`).
2. Immediately after the draft row is first created, call `setCollectionFeeModeAction` with the wizard's
   value, so the stored row matches what the organiser sees from the first save — not only once the fee
   section's step is completed. The RPC already no-ops when unchanged and audits when it changes.
   Without this, a draft abandoned before the fee section stores `community_absorbs` (community default
   via `create_collection`) while the UI showed `contributor_pays`.
3. Resumed drafts keep whatever the row says. Do not silently rewrite stored fee modes on existing drafts.
4. Do **not** change `communities.default_fee_mode` or the column defaults — that is a migration that
   affects every community and every path that creates a collection (including the legacy importer in
   `packages/migration`).
5. Order the radio options with "Contributor pays" first (it already is) and keep the 2px selected border.
   Use one heading for the question (drop the duplicate legend/step heading, §1.3).
6. Review copy unchanged ("Added to what the contributor pays").

**[DECISION D0a]** whether the default should instead be a per-community setting (the column exists:
`communities.default_fee_mode`) rather than a product-wide change.

### 4.3 Image beside title and description (requirement 4)

Constraint: an upload needs a collection id (`uploadCoverAction` is scoped to a real row). Today the event
and story steps solve this by creating the draft on name blur (`ensureDraft`).

Recommended:

- Render the uploader directly under the name field on step 1 of every flow (`details`, `event`, `story`).
- Give `CoverUploader` an optional `ensureCollection: () => Promise<{ id; slug } | null>` prop. When no
  draft exists and the name is valid (≥ 3 chars), choosing a file first awaits draft creation (reusing
  `saveCollectionRow`/`creationRef`, which already prevents double-create), then uploads.
- When the name is not yet valid, the button is disabled with the reason as visible text: "Add a name
  first — the image is saved with it." Show the local preview immediately once enabled (already done via
  `URL.createObjectURL`).
- Remove the standalone `cover` step from all flows.
- Keep "optional" explicit; image remains changeable in Settings.
- Copy: flows other than Tickets currently say "flyer" in the uploader (`CoverUploader.tsx:115`, `:141`).
  Pass a noun prop ("image", "flyer", "cover") so a fundraiser is not asked for a flyer.
- Mobile: `accept="image/jpeg,image/png,image/webp"` already lets phones offer camera or gallery; keep the
  5 MB limit and the client-side checks.

Side effect to accept: uploading an image creates the draft row slightly earlier (already true for
event/story). **[DECISION D8]** whether to instead hold the file in memory and upload after the first
Continue (no early draft, but upload failures then surface on Continue and nothing survives a reload).

### 4.4 Validation (all steps)

- Continue is enabled only when the step's required fields are valid, not merely non-empty.
- Inline errors per field, using the shared Zod schemas; the banner stays for server/network errors.
- Rules to add client-side (all already enforced server-side or by DB): name 3–80; amount format/positive;
  min ≤ max; unique tier/item names (the editors already show the error but `canContinue` ignores it);
  event end ≥ start; sales/order close ≥ open; reference prefix 2–10.
- Soft warnings (do not block): sales close after the event start; closing date in the past.

### 4.5 Progress indication

- **The type picker is not a step** (user requirement, 2026-11-09). Observed today: it is `PURPOSE_STEP`,
  index 0 of `steps = [PURPOSE_STEP, ...flow.steps]` (`NewCollectionForm.tsx:148`), so the header reads
  "Step 1 of 10 · Purpose" and the progress bar has a segment for it (`:568-595`). Recommended:
  - On the picker: heading "New collection", no "Step x of y", no progress bar, no Back/Continue footer.
  - After choosing: "Fixed contribution · Step 1 of 5 · Details". The progress bar has one segment per
    flow step only. Step 1 is the first flow step.
  - Back on Step 1 returns to the picker only while no draft exists (see D7); once a draft exists the
    type is fixed and Back is hidden on Step 1.
  - Resumed drafts never show the picker (already true: `NewCollectionForm.tsx:152`).
- Show the chosen type as context above the step number, e.g. "Fixed contribution · Step 2 of 5 · Amount".
- Labelled stepper on ≥ sm widths (step labels under the bar); compact bar + text on mobile.
- Completed steps are clickable (go back to that step). Forward jumps only to already-completed steps.
- Review gets an "Edit" link on each section that jumps to the owning step; after saving there, Continue
  returns to Review. **[DECISION D9]** (nice-to-have; can follow in a second pass).
- Keep "Your progress is saved automatically" and "Open the draft".

### 4.6 Mobile

- Sticky bottom bar with Back / Continue (Skip on `extras`), respecting safe-area insets.
- `inputMode` on every amount and quantity field.
- Merged steps use collapsible sections where they exceed roughly two phone screens (fee "Show for each
  amount", extras sections).
- Image preview capped in height (already `max-h-64`); the uploader stays above the fold on step 1.
- Test at 360×640 and 390×844; no horizontal scroll; tap targets ≥ 44px (radio cards already are).

### 4.7 Resuming drafts after the change

`draft_step` is an index. Shortening flows changes what an existing draft's index points at. Recommended:
on resume, land on `min(clamped stored step, first step whose required data is missing)`. Every value is
read back from rows, so landing on an earlier step loses nothing, and no draft can skip past an
incomplete required step. No migration is needed. Old drafts that stopped mid-flow may land a step
earlier than before — acceptable.

---

## 5. Implementation map (for when coding is approved)

Suggested order — each phase ships and is testable on its own:

**Phase 1 — cross-cutting, low risk**
1. `packages/domain/src/money.ts`: `formatAmountInput`, `canonicalAmount` + unit tests (caret cases).
2. `packages/ui`: `AmountField`. Swap into every field in §1.4 (wizard + Settings + Obligations).
3. `continue/page.tsx`: fix `toNairaInput` kobo truncation; add a unit test.
4. `ReviewPanel.tsx`, `flows.ts` (`feePreviewRows` labels): format amounts for display.
5. Fee default (only after D0): state default + set-after-create; update `collection-creation.spec.ts`
   expectations.
6a. Type picker out of the step count (§4.5). Lowest-risk approach: keep the internal index unchanged
   (picker stays index 0 internally, so `collections.draft_step` keeps its current meaning and no
   resume logic changes), and change only the display: header text uses `step` of `flow.steps.length`,
   the progress bar maps over `flow.steps`, and the picker renders without header/progress/footer.
   Update `tests/e2e/helpers/wizard.ts` `stepCount()` (today `flow.steps.length + 1`, `:95-96`) and the
   specs that assert literal step numbers: `collection-creation.spec.ts:80` ("Step 2 of … · The event"
   becomes Step 1), `:401` (resume on "Buying" — that step is also merged away in Phase 3),
   `references-and-exports.spec.ts:289` (resume on "Who can order").

**Phase 2 — image to step 1**
6. `CoverUploader.tsx`: `ensureCollection` + noun prop. `NewCollectionForm.tsx`: render on step 1 for all
   flows; reorder flyer/image under the name on `event` and `story`.
7. `flows.ts`: remove `cover` from all flows.

**Phase 3 — step merges**
8. `flows.ts`: new step kinds and per-flow lists (§3). Update `flows.test.ts` assertions that encode the
   old shape (e.g. "gives a timing step to every flow that has dates" → timing fields live in `whoWhen`).
9. `NewCollectionForm.tsx`: render merged kinds by composing existing editors; `persistStep` runs the
   merged step's saves in order (audience → row → fee mode; tiers → event; fields → codes).
   `canContinue` per merged kind.
10. Resume landing rule (§4.7).
11. `tests/e2e/helpers/wizard.ts` is flow-driven and adapts; update `fill` keys in specs that target removed
    kinds (`cover`, `purchaseRules`, `orderRules`, `timing`, `questions`, `reference`), e.g.
    `collection-types.spec.ts:384`, `:445`, `collection-creation.spec.ts:135`.

**Phase 4 — polish (optional)**
12. Clickable stepper, review edit links, sticky mobile bar.

One database migration is required, discovered 2026-11-10:
`supabase/migrations/20261110100000_update_collection_allows_draft_missing_amount.sql`. It teaches
`app.update_collection` the same rule 20260921160100 taught `app.create_collection`: a DRAFT may be
saved without a contribution amount. Before this migration, any Fixed or Recurring draft that was
created by the image upload (which happens before Continue on the new Details step) would refuse to be
updated by the Continue click with "INVALID_AMOUNT: a fixed collection needs a contribution amount
above zero". No other function signature changes; the fee default reuses the existing
`setCollectionFeeModeAction`.

---

## 6. Edge cases

| Case | Handling |
|---|---|
| Caret when a comma is inserted/removed mid-number | caret by significant-character count (§4.1.2) |
| Backspace on a comma | deletes the preceding digit |
| Paste with ₦, spaces, commas, decimals | normalised; excess decimals cut to 2 (or refused if D1 = whole naira) |
| Very long numbers | refuse input beyond the schema's 20-character limit; consider a product cap **[DECISION D10]** |
| Leading zeros, "0", "0.00" | stripped / inline "must be above zero" |
| `5k` shorthand | D2 |
| Resumed draft with kobo amounts | fixed by §4.1.6 |
| Draft abandoned before fee choice | fee mode written on first save (§4.2 step 2) |
| Image chosen before a valid name | button disabled with reason |
| Image upload fails | existing behaviour: preview reverts, inline error |
| Two quick actions both creating the draft | existing `creationRef` guard |
| Back to type picker after draft exists | D7 — recommend: hide "change type" once a draft exists; offer "Discard draft and start again" instead |
| Treasurer without `configure_codes` | references section not rendered in `extras` |
| Recurring + public audience | still not offered (`allowPublic` false) |
| Ticket sales close after event start | soft warning |
| Old `draft_step` after flows shorten | §4.7 landing rule |
| Group audience with no groups | existing message; Continue should be blocked until a group is picked (today it is not) |

---

## 7. Decisions needed

| ID | Question | Owner | Recommendation |
|---|---|---|---|
| **D0** | Ship "Contributor pays" as the default while O-4 (legality of passing a platform fee to contributors) is open with counsel, reversing D-17? | Product + counsel | Do not ship the default flip until a superseding decision is recorded |
| D0a | Product-wide default, or per-community default (`communities.default_fee_mode`)? | Product | Product-wide wizard default, no DB default change |
| D1 | Allow kobo (decimals) in amount fields, or whole naira only? | Product | Whole naira in the wizard UI if no organiser needs kobo; schema stays as is |
| D2 | Keep `5k` shorthand? | Product | Expand on blur |
| D3 | Apply formatting to the contributor pay page too? | Product | Yes, as a follow-up with its own payment-path testing |
| D4 | Keep `extras` in the wizard or move questions/references to Settings only? | Product | Keep, optional, collapsed |
| D5 | Merge fees into the packages/tickets/items step? | Product/Design | Keep separate (length on mobile) |
| D6 | Default ticket "sales close" to event start? | Product | Yes, editable |
| D7 | Allow changing type after a draft exists? | Product | No; offer discard-and-restart |
| D8 | Upload image before the draft exists (in-memory) vs create draft on upload? | Eng/Product | Create draft on upload (existing pattern) |
| D9 | Review "Edit" links and clickable stepper in scope now? | Product | Phase 4 |
| D10 | Upper limit for a single amount? | Product/Finance | Set one (e.g. ₦100,000,000) to catch typos |

Assumptions made in this plan:

- "Every collection type" means the seven flows in `flows.ts`; there are no others in the wizard.
- "Every amount field" covers the organiser-facing fields in §1.4; the contributor page is D3.
- Requirement 3 applies to new collections only; existing collections and drafts keep their stored fee mode.
- No migration is acceptable or desired for this work.

---

## 8. Acceptance checklist

**Flows**
- [ ] Choosing the collection type is a separate screen: no step number, no progress bar segment, not counted in "Step x of y".
- [ ] After choosing a type, the header reads "Step 1 of N" on the flow's first step, and the progress bar has exactly N segments.
- [ ] Each flow matches §3 (step kinds, order, headings); step counts (picker excluded): Fixed 5, Open 5, Packages 6, Items 6, Tickets 6, Fundraising 5, Recurring 5.
- [ ] Resumed drafts open on the correct step with the new numbering, and never show the type picker.
- [ ] No field collected today is missing from the wizard (compare the Review screen before/after for each flow).
- [ ] No screen exists without at least one control (references-only-info and order-rules screens are gone).
- [ ] Merged steps save every part, in the required order (audience before the row; tiers before the event).
- [ ] Each step still saves on Continue; closing the browser and resuming loses nothing.
- [ ] Resuming an old draft lands on or before its first incomplete required step.

**Amount fields**
- [ ] Typing `1000` shows `1,000`; `1234567` shows `1,234,567` in every field in §1.4.
- [ ] Caret stays after the digit just typed when a comma is inserted; Backspace across a comma deletes a digit.
- [ ] Paste of `₦1,234,567` works; letters and minus signs are ignored.
- [ ] Saved value is identical in kobo to the unformatted entry (check DB row for one example per field).
- [ ] Resuming a draft with a kobo amount shows and re-saves the exact amount (§4.1.6).
- [ ] Quantity fields have no separators and still save.
- [ ] Mobile shows a numeric keypad on amount fields.
- [ ] Invalid amounts show an inline error before Continue; min > max is caught before Continue.

**Fees** (only after D0)
- [ ] A new collection shows "Contributor pays" selected and visually distinct.
- [ ] The draft row's `fee_mode` is `contributor_pays` right after the first save, before the fee section is completed.
- [ ] Switching to "You absorb fees" saves and survives resume.
- [ ] Existing drafts and published collections keep their stored fee mode.
- [ ] Review states the chosen policy.

**Image**
- [ ] The image control is on step 1, directly under the name, for all seven flows.
- [ ] It is disabled with a visible reason until the name is valid; then uploading works without leaving the step.
- [ ] No standalone image step remains.
- [ ] Upload, replace and remove still work and show on the public page.
- [ ] Copy says flyer/image/cover appropriately per type.

**Verification to run**
- [ ] `flows.test.ts` updated and passing; new unit tests for `formatAmountInput`/`canonicalAmount` and `toNairaInput`.
- [ ] Type check, lint, build for `apps/web`, `packages/domain`, `packages/ui`.
- [ ] E2E: `collection-creation.spec.ts`, `collection-types.spec.ts`, `audience.spec.ts` walk every flow.
- [ ] Manual pass at 360px and desktop for each flow.
