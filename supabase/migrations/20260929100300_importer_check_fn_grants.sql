-- ─────────────────────────────────────────────────────────────────────────────
-- 20260929100300 — Importer needs EXECUTE on CHECK-constraint helper functions
--
-- collections_suggested_amounts_positive uses app.all_amounts_positive as its
-- CHECK expression. CHECK constraints run with the invoking role, so an INSERT
-- by the importer needs EXECUTE on the function or the CHECK fails.
--
-- The function is deterministic and has no side effects; granting EXECUTE
-- exposes nothing.
-- ─────────────────────────────────────────────────────────────────────────────

grant execute on function app.all_amounts_positive(bigint[]) to kolekto_importer;
