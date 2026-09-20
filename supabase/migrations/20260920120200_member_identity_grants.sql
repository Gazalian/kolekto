-- ─────────────────────────────────────────────────────────────────────────────
-- 20260920120200 — Member identity grants
--
-- The rule 20260917121100 set and every migration since has followed: the
-- grants live in one file, so what a client role can reach is something someone
-- decided rather than something that accumulated.
--
-- `anon` gains NOTHING here. A member code and a matric number identify a
-- person; the anonymous surface stays the three published-collection functions.
-- When a contributor needs to find themselves on a collection page (Milestone
-- 6), that will be its own audience-scoped function returning a whitelist of
-- fields, granted deliberately and asserted in the grant matrix — not a
-- loosening of these.
--
-- Not granted to anything, by design: app.next_member_code and
-- app.set_member_attributes. Both are called only from inside another SECURITY
-- DEFINER function here, which runs as the function owner and needs no grant
-- for the nested call. next_member_code in particular must never be callable on
-- its own: every call consumes a number, so an exposed one is a way to burn a
-- community's sequence.
-- ─────────────────────────────────────────────────────────────────────────────

revoke execute on function app.find_member_duplicates(
  uuid, text, text, extensions.citext, jsonb, uuid
)                                                                                      from public;
revoke execute on function app.create_member(
  uuid, text, text, extensions.citext, jsonb, uuid[], boolean
)                                                                                      from public;
revoke execute on function app.update_member(
  uuid, text, text, extensions.citext, jsonb
)                                                                                      from public;
revoke execute on function app.restore_member(uuid, text)                              from public;
revoke execute on function app.update_member_code_settings(uuid, text, smallint, bigint) from public;
revoke execute on function app.upsert_member_attribute_definition(
  uuid, text, text, public.member_attribute_type, text[], boolean, boolean, boolean, smallint, uuid
)                                                                                      from public;
revoke execute on function app.delete_member_attribute_definition(uuid)                from public;
revoke execute on function app.redeem_invite_link(
  text, text, text, extensions.citext, uuid[]
)                                                                                      from public;


grant execute on function app.find_member_duplicates(
  uuid, text, text, extensions.citext, jsonb, uuid
)                                                                                      to authenticated;
grant execute on function app.create_member(
  uuid, text, text, extensions.citext, jsonb, uuid[], boolean
)                                                                                      to authenticated;
grant execute on function app.update_member(
  uuid, text, text, extensions.citext, jsonb
)                                                                                      to authenticated;
grant execute on function app.restore_member(uuid, text)                               to authenticated;
grant execute on function app.update_member_code_settings(uuid, text, smallint, bigint) to authenticated;
grant execute on function app.upsert_member_attribute_definition(
  uuid, text, text, public.member_attribute_type, text[], boolean, boolean, boolean, smallint, uuid
)                                                                                      to authenticated;
grant execute on function app.delete_member_attribute_definition(uuid)                 to authenticated;

-- MEM-05's anonymous join, re-granted because the function was replaced in
-- 20260920120100 (a CREATE OR REPLACE keeps grants, but this one is restated so
-- the full anon surface is visible in one place rather than inherited silently).
grant execute on function app.redeem_invite_link(
  text, text, text, extensions.citext, uuid[]
)                                                                                      to anon, authenticated;
