-- ─────────────────────────────────────────────────────────────────────────────
-- 20260919120100 — Phase 3 grants: what a client role can execute
--
-- Same rule as 20260917121100 and 20260918140200: the grants live in their own
-- file, so one place decides what a client can reach. A function created in
-- 20260919120000 and not named here is unreachable from both paths — PostgREST
-- does not serve the `app` schema at all (ADR 0011), and the direct connection
-- runs as `anon` or `authenticated`, which hold no EXECUTE without a line here.
--
-- `authenticated` gets EXECUTE on the collection and obligation write
-- functions. Each re-checks app.has_permission against the community it derives
-- from the row, so holding EXECUTE is necessary and never sufficient.
--
-- `anon` gets exactly one addition: app.get_public_collection_fields. It joins
-- app.get_public_collection and app.get_public_collection_tiers as the third
-- and final piece of the published collection page (SEC-12) — a contributor
-- cannot fill in a form whose questions they cannot read.
-- supabase/tests/02_grant_matrix.sql's anon allowlist is updated in the same
-- change, which is what makes adding a fourth one a visible decision rather
-- than an accumulation.
--
-- Not granted to anything, by design: app.generate_unique_collection_slug and
-- app.assert_amount_model_config. Both are called only from inside another
-- SECURITY DEFINER function in the companion migration, which runs as the
-- function owner and needs no grant for the nested call.
-- ─────────────────────────────────────────────────────────────────────────────

-- Retroactive revoke first, for the same reason 20260918140200 states: an
-- `alter default privileges` recorded by one role does not necessarily cover
-- objects another role creates, and PUBLIC's default EXECUTE is inherited by
-- both anon and authenticated. Revoking by name costs one line and removes the
-- question.
revoke execute on function app.create_collection(
  uuid, text, public.collection_category, public.participation_mode, public.amount_model,
  text, public.payment_plan, public.collection_schedule,
  bigint, bigint, bigint, bigint, timestamptz, timestamptz,
  public.collection_visibility, boolean, boolean, text
)                                                                                        from public;
revoke execute on function app.update_collection(
  uuid, text, public.collection_category, text, public.amount_model, public.participation_mode,
  public.payment_plan, bigint, bigint, bigint, bigint, timestamptz, timestamptz,
  public.collection_visibility, boolean, boolean, text
)                                                                                        from public;
revoke execute on function app.delete_draft_collection(uuid)                             from public;
revoke execute on function app.transition_collection_status(
  uuid, public.collection_status, public.collection_status, text
)                                                                                        from public;
revoke execute on function app.set_collection_tiers(uuid, jsonb)                         from public;
revoke execute on function app.set_tier_hidden(uuid, boolean)                            from public;
revoke execute on function app.set_collection_fields(uuid, jsonb)                        from public;
revoke execute on function app.assign_obligations(uuid, uuid[], bigint, timestamptz)     from public;
revoke execute on function app.update_obligation_amount(uuid, bigint)                    from public;
revoke execute on function app.cancel_obligation(uuid, text)                             from public;
revoke execute on function app.exempt_obligation(uuid, text)                             from public;
revoke execute on function app.waive_obligation_amount(uuid, bigint, text)               from public;
revoke execute on function app.get_public_collection_fields(uuid)                        from public;


-- ── authenticated: the collection and obligation write surface ───────────────
grant execute on function app.create_collection(
  uuid, text, public.collection_category, public.participation_mode, public.amount_model,
  text, public.payment_plan, public.collection_schedule,
  bigint, bigint, bigint, bigint, timestamptz, timestamptz,
  public.collection_visibility, boolean, boolean, text
)                                                                                        to authenticated;
grant execute on function app.update_collection(
  uuid, text, public.collection_category, text, public.amount_model, public.participation_mode,
  public.payment_plan, bigint, bigint, bigint, bigint, timestamptz, timestamptz,
  public.collection_visibility, boolean, boolean, text
)                                                                                        to authenticated;
grant execute on function app.delete_draft_collection(uuid)                              to authenticated;
grant execute on function app.transition_collection_status(
  uuid, public.collection_status, public.collection_status, text
)                                                                                        to authenticated;
grant execute on function app.set_collection_tiers(uuid, jsonb)                          to authenticated;
grant execute on function app.set_tier_hidden(uuid, boolean)                             to authenticated;
grant execute on function app.set_collection_fields(uuid, jsonb)                         to authenticated;
grant execute on function app.assign_obligations(uuid, uuid[], bigint, timestamptz)      to authenticated;
grant execute on function app.update_obligation_amount(uuid, bigint)                     to authenticated;
grant execute on function app.cancel_obligation(uuid, text)                              to authenticated;
grant execute on function app.exempt_obligation(uuid, text)                              to authenticated;
grant execute on function app.waive_obligation_amount(uuid, bigint, text)                to authenticated;


-- ── anon: the published collection page, completed ───────────────────────────
grant execute on function app.get_public_collection_fields(uuid)          to anon, authenticated;
