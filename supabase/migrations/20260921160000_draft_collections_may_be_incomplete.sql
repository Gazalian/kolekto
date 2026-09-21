-- ─────────────────────────────────────────────────────────────────────────────
-- 20260921160000 — A draft is allowed to be unfinished
--
-- M7.5 part A: the creation wizard must save each step as the organiser
-- completes it, so leaving the browser does not lose the work. That means a
-- collection row has to exist before the amount has been typed — and
-- `collections_fixed_has_amount` refused exactly that: a fixed collection
-- with no `fixed_amount_kobo` could not be stored at all, draft or not.
--
-- The rule itself is right; its scope was wrong. What actually matters is
-- that nobody can OPEN a fixed collection with no price, and that is already
-- enforced where it belongs — `app.transition_collection_status` refuses to
-- publish with `NOT_PUBLISHABLE: set the contribution amount before
-- publishing` (20260919120000). Enforcing it a second time at insert only
-- prevented the draft, never the bad publish.
--
-- So the constraint is narrowed to published states and left otherwise
-- identical. A draft may be incomplete, because a draft IS the incomplete
-- state; anything a contributor can reach still cannot be.
--
-- Not weakened: every other amount rule (non-negative, min ≤ max, per-member
-- is managed, recurring is managed, installments need a deadline) is
-- untouched, and the publish gate is unchanged.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.collections
  drop constraint collections_fixed_has_amount;

alter table public.collections
  add constraint collections_fixed_has_amount_once_published
  check (
    status = 'draft'
    or amount_model <> 'fixed'
    or fixed_amount_kobo is not null
  );

comment on constraint collections_fixed_has_amount_once_published on public.collections is
  'A fixed collection needs its amount before anyone can reach it. Drafts are exempt because a draft is the unfinished state; app.transition_collection_status refuses to publish one without an amount.';
