-- ─────────────────────────────────────────────────────────────────────────────
-- 20260921160300 — The new assert_amount_model_config is not for anon
--
-- Caught by 02_grant_matrix.sql: a newly created function carries Postgres's
-- default EXECUTE grant to PUBLIC, so the six-parameter overload added in
-- 20260921160100 appeared in `anon`'s executable set. The five-parameter
-- version it replaced had been revoked in 20260919120100; the replacement
-- inherited nothing, because it is a different function.
--
-- It is a pure validator that reads no table, so nothing leaked — but the
-- allowlist in the grant matrix is the point: what `anon` may execute is
-- enumerated on purpose, and a function joining that list silently is the
-- failure mode the test exists to catch.
-- ─────────────────────────────────────────────────────────────────────────────

revoke execute on function app.assert_amount_model_config(
  public.amount_model, bigint, bigint, bigint, bigint, boolean
) from public;
