-- ─────────────────────────────────────────────────────────────────────────────
-- 20260920160400 — Grants for the type-specific functions
--
-- Two of these are re-grants rather than new ones: app.get_public_collection and
-- app.sync_collection_obligations were dropped and recreated in the previous
-- file (a return type and a signature changed), and dropping a function takes
-- its grants with it. Restated here so the reachable surface is described in one
-- place (20260917121100's rule).
--
-- `anon` gains exactly one new function: app.get_public_collection_items, the
-- items a published collection offers. It joins the three reads the published
-- page already had, and the allowlist in 02_grant_matrix.sql is updated in the
-- same change.
-- ─────────────────────────────────────────────────────────────────────────────

revoke execute on function app.set_collection_items(uuid, jsonb)                        from public;
revoke execute on function app.set_item_hidden(uuid, boolean)                           from public;
revoke execute on function app.set_collection_event(uuid, timestamptz, timestamptz, text) from public;
revoke execute on function app.set_collection_suggested_amounts(uuid, bigint[])         from public;
revoke execute on function app.set_collection_recurrence(
  uuid, public.recurrence_frequency, smallint, date, smallint
)                                                                                        from public;
revoke execute on function app.open_collection_cycle(uuid)                              from public;
revoke execute on function app.get_public_collection(text, text)                        from public;
revoke execute on function app.get_public_collection_items(uuid)                        from public;
revoke execute on function app.sync_collection_obligations(uuid, bigint, timestamptz, text) from public;
revoke execute on function app.count_collection_audience(uuid)                          from public;

grant execute on function app.set_collection_items(uuid, jsonb)                          to authenticated;
grant execute on function app.set_item_hidden(uuid, boolean)                             to authenticated;
grant execute on function app.set_collection_event(uuid, timestamptz, timestamptz, text) to authenticated;
grant execute on function app.set_collection_suggested_amounts(uuid, bigint[])           to authenticated;
grant execute on function app.set_collection_recurrence(
  uuid, public.recurrence_frequency, smallint, date, smallint
)                                                                                        to authenticated;
grant execute on function app.open_collection_cycle(uuid)                                to authenticated;
grant execute on function app.sync_collection_obligations(uuid, bigint, timestamptz, text) to authenticated;
grant execute on function app.count_collection_audience(uuid)                            to authenticated;

-- The published page, for someone with no account.
grant execute on function app.get_public_collection(text, text)   to anon, authenticated;
grant execute on function app.get_public_collection_items(uuid)   to anon, authenticated;
