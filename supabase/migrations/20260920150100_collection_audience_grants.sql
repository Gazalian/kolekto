-- ─────────────────────────────────────────────────────────────────────────────
-- 20260920150100 — Collection audience grants
--
-- `anon` gains nothing. An audience is a list of who a community expects to pay;
-- the anonymous surface stays the published collection page and the invitation.
--
-- app.resolve_collection_audience is granted to nobody on purpose: it returns a
-- community's member ids, and every screen that needs them already reads
-- `members` under RLS. It exists so the sync and the count agree by
-- construction, and is reached only from inside them.
-- ─────────────────────────────────────────────────────────────────────────────

revoke execute on function app.set_collection_audience(
  uuid, public.collection_audience_mode, uuid[]
)                                                                                  from public;
revoke execute on function app.count_collection_audience(uuid)                     from public;
revoke execute on function app.sync_collection_obligations(uuid, bigint, timestamptz) from public;

grant execute on function app.set_collection_audience(
  uuid, public.collection_audience_mode, uuid[]
)                                                                                  to authenticated;
grant execute on function app.count_collection_audience(uuid)                      to authenticated;
grant execute on function app.sync_collection_obligations(uuid, bigint, timestamptz) to authenticated;
