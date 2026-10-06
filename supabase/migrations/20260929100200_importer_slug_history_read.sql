-- ─────────────────────────────────────────────────────────────────────────────
-- 20260929100200 — Importer needs SELECT on the slug-history tables it consults
--
-- app.generate_unique_community_slug and app.generate_unique_collection_slug
-- are STABLE SECURITY INVOKER (search_path = ''), so they run with the
-- invoking role's privileges. Both consult a slug-history table for uniqueness:
-- community_slug_history, and possibly collection_slug_history. The importer
-- needs SELECT on those tables. It does not insert into them.
-- ─────────────────────────────────────────────────────────────────────────────

grant select on public.community_slug_history to kolekto_importer;
