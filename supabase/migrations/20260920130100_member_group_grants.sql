-- ─────────────────────────────────────────────────────────────────────────────
-- 20260920130100 — Member group grants
--
-- One file decides what a client role can reach (20260917121100). `anon` gains
-- nothing: a group name tells you which flats are in Block B, and the anonymous
-- surface stays the published-collection functions.
--
-- Every function is revoked from PUBLIC by name first. Postgres grants EXECUTE
-- to PUBLIC on creation and the retroactive revoke in 20260917121100 can only
-- reach what existed then — the omission that left two trigger functions
-- anon-executable in 20260920120000 and was caught by the grant matrix.
-- ─────────────────────────────────────────────────────────────────────────────

revoke execute on function app.create_member_group(uuid, text, text, boolean, smallint)  from public;
revoke execute on function app.update_member_group(uuid, text, text, boolean, smallint)  from public;
revoke execute on function app.set_member_group_archived(uuid, boolean, text)            from public;
revoke execute on function app.delete_member_group(uuid)                                  from public;
revoke execute on function app.add_members_to_group(uuid, uuid[])                         from public;
revoke execute on function app.remove_member_from_group(uuid, uuid)                       from public;
revoke execute on function app.set_member_groups(uuid, uuid[])                            from public;

grant execute on function app.create_member_group(uuid, text, text, boolean, smallint)   to authenticated;
grant execute on function app.update_member_group(uuid, text, text, boolean, smallint)   to authenticated;
grant execute on function app.set_member_group_archived(uuid, boolean, text)             to authenticated;
grant execute on function app.delete_member_group(uuid)                                   to authenticated;
grant execute on function app.add_members_to_group(uuid, uuid[])                          to authenticated;
grant execute on function app.remove_member_from_group(uuid, uuid)                        to authenticated;
grant execute on function app.set_member_groups(uuid, uuid[])                             to authenticated;
