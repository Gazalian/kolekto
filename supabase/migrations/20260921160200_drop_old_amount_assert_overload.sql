-- ─────────────────────────────────────────────────────────────────────────────
-- 20260921160200 — One assert_amount_model_config, not two
--
-- 20260921160100 added a sixth parameter with a default, which does not
-- replace the five-parameter function: it creates an overload beside it. Every
-- existing five-argument call — `app.update_collection` among them — then
-- fails with "function ... is not unique", because a six-parameter function
-- whose last parameter has a default is an equally good candidate.
--
-- The five-parameter version is dropped. Callers that pass five arguments now
-- resolve to the new function with `p_allow_missing_amount` defaulting to
-- false, which is exactly the behaviour they had before.
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists app.assert_amount_model_config(
  public.amount_model, bigint, bigint, bigint, bigint
);
