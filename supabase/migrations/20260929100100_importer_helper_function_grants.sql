-- ─────────────────────────────────────────────────────────────────────────────
-- 20260929100100 — Helper-function EXECUTE for kolekto_importer
--
-- Forward-only follow-up to 20260929100000. app.generate_unique_community_slug
-- and app.generate_unique_collection_slug internally call app.slugify, so the
-- importer must be able to execute that too. app.uuid_generate_v7 was named as
-- the id default in the previous migration and is already granted in
-- 20260928120600 — restated here idempotently for clarity.
--
-- Nothing else changes.
-- ─────────────────────────────────────────────────────────────────────────────

grant execute on function app.slugify(text)             to kolekto_importer;
grant execute on function app.uuid_generate_v7()        to kolekto_importer;
