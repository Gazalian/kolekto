# Collection financial overview and contributor register — audit and design

**Date:** 2026-11-16
**Branch:** `feat/payment-receipts-alarms` (work is uncommitted until the owner approves)
**Scope:** audit of the existing collection, contributor and money architecture; the design and
implementation of a per-collection financial overview, contributor register, acknowledgement and
contributor export that works the same way for every collection type.

---

## 1. Audit — what exists today (read from the code, not assumed)

### 1.1 Collection types

There is **no `collection_type` column** (ADR 0013). A type is a combination of axes on
`public.collections`, chosen by the creation flow (`apps/web/app/c/[slug]/collections/new/flows.ts`,
seven intents: fixed, open, tiered, items, ticketing, fundraiser, recurring):

| Axis | Values | Where |
| --- | --- | --- |
| `category` | dues, contribution, event, fundraiser, items, other | `collection_category` enum |
| `participation_mode` | open (anyone with the link), managed (a roll of members) | enum |
| `audience_mode` | public, all_members, groups, selected_members | enum |
| `amount_model` | fixed, open_amount, tiers, per_member, items | enum |
| `schedule` | one_time, recurring (+ `collection_recurrences`, `collection_cycles`) | enum |
| Type facts | `collection_tiers`, `collection_items`, `suggested_amounts_kobo`, `event_starts_at`/`venue`, `target_amount_kobo`, `close_when_target_reached` | rows / columns |

Consequence for this feature: one register and one overview, driven by the collection's own rows
(tiers, items, fields, cycles), never by a type switch.

### 1.2 Contributor information

| What | Stored in | Notes |
| --- | --- | --- |
| Payment contact (name, email, phone) | `contribution_intents.contributor_name/_email/_phone` | All three required at checkout (owner decision 2026-11-11). PII. |
| Organiser questions ("custom fields") | definitions: `collection_fields` (key, label, type ∈ text/number/single_select/date, options, required, sort_order); answers: `contribution_intents.answers` jsonb `{key: string}` | Up to 10 per collection. **The system already separates payment contact data from organiser-defined answers.** |
| Event attendee names | `contribution_intents.attendee_names text[]` | One per ticket unit when `collect_attendee_details` is on. |
| Saved community members | `members` (full_name, member_code, phone_e164, email) + `member_attribute_definitions/values` | A contributor identified on a managed collection (ADR 0014) carries `member_id` on the intent, attempt and contribution. Members are **not** user accounts. |
| Guests | intent row only (`member_id` null) | No profile. |
| What they bought | `contribution_lines` (tier_id / item_id, quantity, unit price) | Empty for fixed / open amounts. |
| Repeat payments | One `contributions` row per completed attempt; nothing groups them | Identity must be derived. |

`collection_fields` is replaced wholesale by `app.set_collection_fields` (delete + insert), so an
answer can outlive its field definition. The register must label it gracefully.

### 1.3 Payment and money lifecycle

```
contribution_intents ─► payment_attempts (created → initialized → captured → completed
                                          ↘ failed / expired / needs_review)
                            │ provider_transactions (append-only raw provider events, T1)
                            ▼ complete_payment_capture (T2, idempotent, row-locked)
                        contributions (1 per attempt: unique attempt_id) + contribution_lines
                            │
                            ▼ ledger journals (append-only, balanced, collection-scoped)
   capture       Dr provider_receivable   Cr collection_pending   (total charged)
   fee           Dr collection_pending    Cr platform_fee_income / vat_payable (fees shown)
   provider_fee  Dr provider_fee_expense  Cr provider_receivable
```

* **Source of truth for money:** `ledger_entries` (ADR 0015, invariant 7). `v_collection_position`
  sums them per collection into pending / available / on_hold / withdrawing / withdrawn /
  chargeback / refund_reserve. No balance column exists anywhere.
* **Source of truth for "paid":** `contributions` with `status = 'applied'` (the only value today).
  Duplicate provider events, duplicate verifies and double clicks cannot create a second row
  (unique `attempt_id`, unique journal idempotency keys, content-hash dedupe on provider events).
* **T+1 (D-09):** decided as 05:00 Africa/Lagos the next calendar day, and **availability is a
  recorded event** (a `balance_release` journal), never a clock comparison (D-09c).
  `availableAt()` exists in `packages/domain/src/settlement.ts`. **The release worker is not built**
  (D-09d), so nothing ever moves `collection_pending → collection_available` today.
* **Withdrawals:** decided (D-03..D-08), **not built.** There is no `withdrawals` table, no
  withdrawal journal writer, no UI. `collection_withdrawn` is always zero.
* **Refunds / reversals:** deferred through launch (D-31). `contribution_status` has only
  `applied`; corrections would be reversing journals. Nothing writes either today.
* **`needs_review`:** money the provider confirmed but the capture parked (amount mismatch,
  already paid, obligation changed). No contribution, no journal — it is in neither Raised nor
  Pending until an operator resolves it.
* **Edge Functions:** none by design (ADR 0005). Server work runs in Next.js server actions and
  `apps/worker`.

### 1.4 Authorization

Permissions are rows (`permissions`, `role_permissions`), roles owner / admin / treasurer /
collector (scoped to collections) / viewer. Relevant today:

| Permission | owner | admin | treasurer | collector | viewer |
| --- | --- | --- | --- | --- | --- |
| `transaction.view` | ✓ | ✓ | ✓ | scoped | ✓ |
| `balance.view` | ✓ | ✓ | ✓ | — | ✓ |
| `member.view_contact` | ✓ | ✓ | ✓ | scoped | ✓ |
| `member.export` | ✓ | ✓ | ✓ | — | — |
| `contribution.acknowledge` (new) | ✓ | ✓ | ✓ | scoped | — |

`app.has_permission_for_collection` honours collector scope. Payment tables are RLS-forced with
officer SELECT via `transaction.view`; ledger tables via `balance.view`.

### 1.5 Existing screens

* Collection page tabs: Overview, Members/Attendees/Orders (managed only), Check-in (events),
  Exports, Activity, Settings.
* The Overview tab still shows **"Online payment is not switched on yet"** — false since M8.
* The Exports tab exports the **obligation roll** (who is expected), never what was received. It
  has a field picker, paging with a 20 000-row ceiling, an audit record per export, CSV + PDF.
* **No screen shows any contribution or any balance.**

### 1.6 Gaps and inconsistencies found

1. No organiser view of money or of who paid, although every record needed exists.
2. Stale "payment is not switched on" banner on the Overview tab and in the roll-export PDF note.
3. T+1 release and withdrawals are decided but not built, so Available and Withdrawn are zero.
4. `20260917121100_grants.sql` (SEC-14) says contributions should be served through functions,
   not table SELECT; `20261111100000` granted officer SELECT on `contributions` and
   `contribution_intents`. Not changed here (RLS still limits rows to `transaction.view`), but the
   new screens read only through permission-checked functions, as SEC-14 intended.
5. Collection custom questions can be deleted and recreated; old answers keep their keys.
6. No organiser-side "seen it" marker exists. `contributions` is immutable, so it cannot live there.

---

## 2. Design

### 2.1 Principles

* **No new ledger, no new balance.** Every money figure is read from `contributions` (gross) or
  `ledger_entries` (position). The overview is a read.
* **One shared implementation.** One SQL function per concern, one panel, one export path, used by
  every collection type; differences come from the collection's tiers / items / fields.
* **Server-side only.** Figures, filtering, counting and export rows come from SECURITY DEFINER
  functions that check permission against the collection (collector scope honoured). The browser
  never calculates money.
* **Acknowledgement is its own table** and touches nothing financial.

### 2.2 Financial overview — methodology

All amounts integer kobo; formatted only at the edge.

| Figure | Definition | Source |
| --- | --- | --- |
| Total raised | Σ `contribution_kobo` of `contributions` with `status = 'applied'` (gross, before fees; D-30's definition) | `contributions` |
| Fees deducted | Σ (`contribution_kobo` − `net_kobo`) — fees the organiser bore (zero when the contributor paid fees) | `contributions` |
| Pending settlement | balance of `collection_pending` | ledger |
| Available | balance of `collection_available` | ledger |
| On hold / withdrawing | balances of `collection_on_hold` / `collection_withdrawing` (shown only when non-zero) | ledger |
| Total withdrawn | balance of `collection_withdrawn` | ledger |
| Unique contributors | count of distinct contributor keys (§2.4) | `contributions` + intents |
| Successful contributions | count of applied contributions | `contributions` |
| Under review | count of `payment_attempts` in `needs_review` (not money in any figure) | attempts |

Reconciliation identity, true by construction of the capture journals:
`Total raised − Fees deducted = Pending + Available + On hold + Withdrawing + Withdrawn` (+ chargeback
/ refund reserve once those exist). A pgTAP test asserts it.

**T+1:** the overview shows what the ledger says. A payment is Pending until a `balance_release`
journal moves it; it can never be in both because a journal is balanced (it debits one account
and credits the other). This feature does **not** post releases: doing that on a clock would break
D-09c and the requirement not to treat elapsed time as settlement, and the provider-side settlement
confirmation (PA-04) is unverified. When the release worker is built, the overview needs no change.

Money figures need `balance.view`; counts and Total raised need `transaction.view`. A caller with
only `transaction.view` (today: a collector, within their scope) gets the counts and Total raised,
and the balance cards are not shown.

### 2.3 Contributor register

`app.collection_contributors(collection, search, acknowledged, include_contact, limit, offset, ids)`:

* Rows: one per **applied contribution** (failed / abandoned / pending / review attempts never
  appear). Newest first, paged in the database (`limit ≤ 200`), `total_count` returned.
* Name: the member's profile name when the payment was made as a saved member, otherwise the name
  typed at checkout. `is_member` + `member_code` tell them apart.
* Collection-specific data: `answers` (the organiser's questions), `lines` (tier / item names and
  quantities), `attendee_names`, `cycle_key`. Labels come from `collection_fields`; the UI never
  shows a raw key or JSON.
* Contact (email, phone) is **not returned** unless `include_contact` is set, which additionally
  requires `member.view_contact`.
* Search: case-insensitive over name, KLK reference, member code and answer values (LIKE wildcards
  escaped). Filter: all / acknowledged / not acknowledged.
* Needs `transaction.view` for the collection.

### 2.4 Contributor identity (repeat contributors)

Key = `member:<member_id>` when the payment was made as a saved member, else
`email:<lower(trim(contributor_email))>`. Email is required and verified by the provider at
checkout, so it is the most reliable identifier a guest has; names are never used. Each payment
stays its own row; the register also returns `contributor_total_kobo` and
`contributor_payment_count` for the person across the whole collection.

### 2.5 Acknowledgement

* Table `contribution_acknowledgements (contribution_id PK → contributions, collection_id,
  community_id, acknowledged_by → users, acknowledged_at)`. RLS forced, no client grants; written
  and read only through functions.
* `app.acknowledge_contributions(collection, ids[] | null, as_of)` — inserts, idempotent
  (`on conflict do nothing`), only for contributions of that collection; `ids = null` means "all
  not yet acknowledged, captured at or before `as_of`" so a payment that lands while the organiser
  is looking is not silently acknowledged. One audit-log row per call (counts only).
* New permission `contribution.acknowledge`: owner, admin, treasurer, collector (scoped). Viewer is
  read-only and does not get it.
* Acknowledgement changes no contribution, attempt, obligation or journal.

### 2.6 Export

New subject on the collection page's Contributors tab (the existing roll export is unchanged).
Fields are generated from the collection: Basic (name, amount, date, option / items, period,
member code), Contact (email, phone — off by default, needs `member.view_contact`), every
organiser question by its label, Management (acknowledged, acknowledged at, payment reference,
contributor total). Respects search and the acknowledgement filter. Server action pages the same
SQL function (200 rows per call, 20 000-row ceiling refuses rather than truncates), builds CSV with
the existing `toCsv` (formula-injection safe), and records an audit row with column names only.
Needs `member.export` plus `transaction.view`. XLSX is not offered: no spreadsheet library is in
the repository, and CSV opens in Excel.

---

## 3. Implementation record

### 3.1 Database — `supabase/migrations/20261116130000_collection_contributor_register.sql`

Additive only. No existing table, column, function or row is changed; no stored amount is
written. Rollback (in the file header): drop the three functions, the table, the trigger
function, the unique index, and the `contribution.acknowledge` permission rows.

* Permission `contribution.acknowledge` → owner, admin, treasurer, collector (scoped).
* Unique index `contributions (id, collection_id)` — target of the acknowledgement's composite
  foreign key, so an acknowledgement can never point at another collection's payment.
* Table `contribution_acknowledgements` — RLS forced, deny-all policy, no grants to `anon` /
  `authenticated`; a trigger checks the community owns the collection.
* `app.collection_financial_overview(collection)` — §2.2. Balances are NULL unless the caller has
  `balance.view`.
* `app.collection_contributors(...)` — §2.3 / §2.4.
* `app.acknowledge_contributions(...)` — §2.5. At most 1 000 ids per call.

All three are SECURITY DEFINER with an empty `search_path`, check permission against the
collection first, and raise `FORBIDDEN:` otherwise.

### 3.2 Application

| Layer | File |
| --- | --- |
| Data access | `packages/db/src/contributors.ts` (exported from `@kolekto/db`) |
| Shared pure helpers (views, answer labelling, export fields, CSV columns) | `apps/web/app/c/[slug]/collections/[collectionSlug]/contributor-register.ts` |
| Server actions (list, detail, acknowledge, export) | `.../contributor-actions.ts` |
| Overview UI | `.../FinancialOverview.tsx` |
| Register, detail drawer, bulk acknowledge, export picker | `.../ContributorsPanel.tsx` |
| Wiring (first page loaded on the server, new Contributors tab) | `.../page.tsx`, `.../CollectionDetailClient.tsx` |

Stale "online payment is not switched on" copy was removed from the Overview tab, the roll
export panel and the roll export PDF note. The tab bar now scrolls sideways on narrow screens
instead of widening the page.

## 4. Results, limitations and recommendations

### 4.1 Verification (2026-11-16)

* pgTAP `supabase/tests/56_contributor_register.sql`: 49/49 on the itest database. Covers the
  overview figures and the reconciliation identity, repeat contributors by member and by
  case-insensitive email, failed and under-review attempts excluded, contact hidden by default,
  search escaping, paging, acknowledgement idempotency / cross-collection refusal / `as_of` /
  audit row, acknowledgement leaving every figure unchanged, collector scope, viewer refused,
  outsider refused, no `anon` access.
* Full pgTAP suite with this migration: no new failures. 32, 34 and 38 fail identically with and
  without it (existing itest state).
* `apps/web`: `tsc --noEmit` clean, vitest 214/214 (13 new for the register helpers), eslint clean
  on the collection folder; root `npm run typecheck` clean; invariant scripts clean.
* Browser, local dev, as a treasurer: overview figures match a direct database query; register,
  detail drawer with contact, single acknowledge, export (3 rows, audit row with headers only),
  375 px layout.

Not verified: CSV file contents downloaded in a browser (unit-tested only); tiered and
question-heavy collections in the UI (pgTAP only); collector and viewer in the UI (pgTAP only);
Playwright E2E not run.

### 4.2 Limitations

1. **Available and Total withdrawn read ₦0** until the T+1 `balance_release` worker and
   withdrawals exist. The overview reads the ledger and needs no change when they land.
2. No un-acknowledge. Acknowledgement is a one-way marker; an undo needs its own audited function.
3. XLSX is not offered (no spreadsheet library in the repository).
4. Answers to questions that were later removed are still shown, labelled from their key and
   marked "removed question".
5. SEC-14 inconsistency (§1.6 item 4) is unchanged.
6. Other stale "payment not switched on" copy remains in `FeeConfigurator.tsx`,
   `CheckInPanel.tsx` and `ObligationsPanel.tsx`.

### 4.3 Recommendations

1. Build the T+1 release worker (D-09) next; it is the only thing between this screen and a
   non-zero Available balance.
2. Decide SEC-14: either revoke the officer table SELECT on `contributions` /
   `contribution_intents` (the new screens do not need it) or amend the decision.
3. Remove the remaining stale payment copy.
4. Add a Playwright spec for the Contributors tab once the payment E2E fixtures are stable.
