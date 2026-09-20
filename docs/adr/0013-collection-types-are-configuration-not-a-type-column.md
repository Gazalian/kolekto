# 0013 — A collection's type is its configuration, not a label on it

**Status:** Accepted · 2026-09-20

## Context

Kolekto has to support seven recognisable kinds of collection: a fixed amount,
an open amount, options at different prices, a fundraiser, an order of items,
tickets for an event, and a charge that repeats. Organisers name these things
readily — "I am selling aso-ebi", "I am collecting the service charge" — and
expect the product to ask them the questions that kind of collection needs.

Three shapes were available:

1. **A `collection_type` column.** One enum on `collections`, with the
   behaviour of each type decided in application code.
2. **A `type_config jsonb` column.** One bag per collection holding whatever
   that type needs — items, an event date, a recurrence.
3. **Named columns and tables for each fact, chosen by the form.** The type
   lives in the creation flow; what it produces is `suggested_amounts_kobo`,
   `event_starts_at`, `venue`, `collection_items`, `collection_recurrences`
   and `collection_cycles`.

## Decision

**Option 3.** There is no `collection_type` column, and no configuration blob.
The creation flow presents seven intents, and each intent decides which
questions are asked and which of the existing axes (participation mode, amount
model, payment plan, schedule) are set. Everything an intent collects is stored
as something the database can check.

Option 1 was rejected because a type column and the axes would be two sources
of truth for the same thing. A row could say `type = 'ticketing'` and
`amount_model = 'fixed'`, and nothing in the schema could say which one was
wrong. The axes already decide how money is resolved; a label beside them adds
no information and invites drift.

Option 2 was rejected for the reason ADR 0010 exists. A jsonb bag cannot hold a
foreign key, a unique index, a CHECK constraint or a money invariant. An item
price inside `type_config` would be a JSON number — a float — in a system whose
first invariant is that money is integer kobo (ADR 0003), and it would be
invisible to the test that enforces it. An item inside a bag has no stable id,
so renaming it would be indistinguishable from replacing it: the 2026-08-06
incident, restaged in a different column.

## Consequences

Each type's configuration is a first-class part of the schema:

- **Items** are rows in `collection_items`, with ids, a `app.kobo` price, a
  unique name per collection, and stock. They are resolved by id in
  `resolveContributionAmount`, like tiers, and a quantity is bounded by the
  database's limits rather than the browser's.
- **An event** is `event_starts_at` / `event_ends_at` / `venue` on the
  collection, deliberately distinct from `starts_at` and `deadline_at`, which
  are when the collection sells tickets. The event's date and venue stay
  editable after publication — a moved venue must be announceable — while the
  ticket price locks, like every other published price.
- **A recurring charge** is `collection_recurrences` plus `collection_cycles`.
  A member owes once per cycle, which is what `obligations`' unique index on
  `(collection_id, member_id, cycle_key)` has enforced since Phase 1. Both ways
  of creating an obligation — `assign_obligations` and
  `sync_collection_obligations` — require a period on a recurring collection
  and refuse one on any other.
- **Suggested amounts** are `bigint[]`, with the money invariant extended to
  resolve through an array's element type: an array of money is still money.

Opening a period is a deliberate act (`app.open_collection_cycle`), never a
scheduled job. Creating the obligations for that period is a second deliberate
act. Kolekto does not create a debt while nobody is looking.

The cost of this shape is that adding an eighth kind of collection means a
migration rather than a new JSON key, and the creation flow grows a branch. That
is the intended trade: what an organiser configures is what a contributor will
be charged, and every part of it should be something the database can refuse.
