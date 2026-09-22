-- ─────────────────────────────────────────────────────────────────────────────
-- 20260922100100 — An index the door search can actually use
--
-- 20260921180000 created `contributor_references_lookup_idx` on
-- `(community_id, reference text_pattern_ops)` on the reasoning that somebody
-- at a door searches by code. Two things were wrong with it:
--
--   · the door search filters by `collection_id`, not `community_id`, so the
--     leading column never matches the query
--   · it searched with ILIKE, and `text_pattern_ops` supports LIKE, not ILIKE
--
-- So the index was decorative: correct-looking, and never chosen by the
-- planner. This replaces it with one scoped the way the query is scoped, and
-- the search now upper-cases its needle and uses LIKE — which is not a
-- behaviour change, because `contributor_references_format` already restricts
-- a reference to upper-case letters, digits and `. / -`.
--
-- Dropping an index destroys no data and no constraint; the unique indexes
-- that hold CODE-04 are untouched.
-- ─────────────────────────────────────────────────────────────────────────────

drop index if exists public.contributor_references_lookup_idx;

create index contributor_references_lookup_idx
  on public.contributor_references (collection_id, reference text_pattern_ops);

comment on index public.contributor_references_lookup_idx is
  'M7.6: prefix search by code within one collection — what somebody standing at a door types after a guest reads their reference out. text_pattern_ops because the query is LIKE on an upper-cased needle, which the reference format guarantees is equivalent to a case-insensitive one.';
