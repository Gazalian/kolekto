-- ─────────────────────────────────────────────────────────────────────────────
-- 20260920170200 — Grants for the contributor identification surface
--
-- Two functions join the anon whitelist, and one is re-granted after being
-- recreated. Every one of them is read-only, scoped to a single collection, and
-- returns only what the person in front of the page needs.
--
-- What is NOT granted, and must never be: app.resolve_collection_audience.
-- It answers "who is this collection for" in full, which is the member list
-- itself. The two functions below call it internally as SECURITY DEFINER; that
-- is the only way it is reachable.
--
-- The grant matrix test (supabase/tests/02_grant_matrix.sql) asserts the anon
-- whitelist exactly, so adding a function here without adding it there fails
-- the suite — which is the point.
-- ─────────────────────────────────────────────────────────────────────────────

-- PUBLIC's implicit EXECUTE first, then the roles we mean (the Phase 1
-- retroactive revoke cannot reach functions created after it).
revoke execute on function app.collection_accepts_identification(uuid) from public;
revoke execute on function app.find_collection_member(uuid, text)      from public;
revoke execute on function app.get_collection_member_context(uuid, uuid) from public;
revoke execute on function app.get_public_collection(text, text)       from public;

grant execute on function app.find_collection_member(uuid, text)        to anon, authenticated;
grant execute on function app.get_collection_member_context(uuid, uuid) to anon, authenticated;
grant execute on function app.get_public_collection(text, text)         to anon, authenticated;

-- Deliberately not granted to anyone: it is an internal predicate, and the two
-- public functions above already expose everything about it that is safe.
revoke all on function app.collection_accepts_identification(uuid) from anon, authenticated;
