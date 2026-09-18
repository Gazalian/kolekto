-- ─────────────────────────────────────────────────────────────────────────────
-- 20260918140200 — Phase 2 grants: what a client role can execute
--
-- Following 20260917121100's own rule: "The grants live HERE rather than
-- beside each function... One file decides what a client can reach." Every
-- function created in 20260918140100 is unreachable by `anon` or
-- `authenticated` unless it is named below.
--
-- `authenticated` gets EXECUTE on every write function from
-- 20260918140100 — each one re-checks app.has_permission internally, so
-- holding EXECUTE is necessary but never sufficient to write anything.
--
-- `anon` gets exactly one addition: app.redeem_invite_link, the single
-- anonymous write path in the schema (MEM-05: a member joins with no
-- account). supabase/tests/02_grant_matrix.sql's allowlist for anon is
-- updated in the same change, so adding a fourth one later is the same kind
-- of visible, reviewed decision this file's predecessor describes.
--
-- Not granted to anything, by design: app.require_permission,
-- app.generate_secret_token, app.slugify, app.generate_unique_community_slug,
-- app.handle_new_auth_user, app.assert_is_invitee. Each is called only from
-- inside another SECURITY DEFINER function in this file's companion
-- migrations, which runs as the function owner and needs no grant for the
-- nested call.
-- ─────────────────────────────────────────────────────────────────────────────

-- 20260917121100 granted USAGE on schema `app` to `authenticated` only — at
-- that point nothing in `app` was callable by `anon` at all. redeem_invite_link
-- changes that (MEM-05), so `anon` needs the same USAGE. This still grants
-- nothing by itself: PostgREST never routes to `app` regardless (`schemas =
-- ["public"]`, supabase/config.toml), and within a direct-connection server
-- call that sets `role anon` for the duration (the same impersonation pattern
-- supabase/tests uses), USAGE only makes the schema's objects nameable —
-- EXECUTE, granted per function below, is what actually authorizes a call.
grant usage on schema app to anon;

-- Retroactive revoke, same reasoning as 20260917121100's own: `alter default
-- privileges` does not reach back to cover functions created by an earlier
-- migration, and every function below was created in 20260918140100, before
-- this file ran. Without this, PUBLIC — and therefore anon and authenticated,
-- which both inherit it — could execute every one of them regardless of the
-- grants that follow.
revoke execute on function app.create_community(text, public.community_type, text)                          from public;
revoke execute on function app.update_community_profile(
  uuid, text, text, text, text, text, text, extensions.citext, text, boolean
)                                                                                                             from public;
revoke execute on function app.create_member(uuid, text, text, extensions.citext, text, jsonb, uuid[])       from public;
revoke execute on function app.update_member(uuid, text, text, extensions.citext, text, jsonb)                from public;
revoke execute on function app.archive_member(uuid, text)                                                     from public;
revoke execute on function app.create_invite_link(
  uuid, uuid[], boolean, boolean, boolean, timestamptz, integer, text
)                                                                                                              from public;
revoke execute on function app.revoke_invite_link(uuid)                                                       from public;
revoke execute on function app.redeem_invite_link(text, text, text, extensions.citext, uuid[])                from public;
revoke execute on function app.approve_pending_member(uuid)                                                   from public;
revoke execute on function app.reject_pending_member(uuid, text)                                              from public;
revoke execute on function app.create_officer_invitation(
  uuid, public.officer_role, text, jsonb, text, text, extensions.citext
)                                                                                                              from public;
revoke execute on function app.revoke_officer_invitation(uuid)                                                from public;
revoke execute on function app.accept_officer_invitation(text)                                                from public;
revoke execute on function app.decline_officer_invitation(text)                                               from public;
revoke execute on function app.end_officer_term(uuid, text)                                                   from public;

grant execute on function app.create_community(text, public.community_type, text) to authenticated;
grant execute on function app.update_community_profile(
  uuid, text, text, text, text, text, text, extensions.citext, text, boolean
) to authenticated;

grant execute on function app.create_member(uuid, text, text, extensions.citext, text, jsonb, uuid[]) to authenticated;
grant execute on function app.update_member(uuid, text, text, extensions.citext, text, jsonb)          to authenticated;
grant execute on function app.archive_member(uuid, text)                                                to authenticated;

grant execute on function app.create_invite_link(
  uuid, uuid[], boolean, boolean, boolean, timestamptz, integer, text
) to authenticated;
grant execute on function app.revoke_invite_link(uuid)         to authenticated;
grant execute on function app.approve_pending_member(uuid)     to authenticated;
grant execute on function app.reject_pending_member(uuid, text) to authenticated;

-- The one anonymous write path in the schema (MEM-05).
grant execute on function app.redeem_invite_link(text, text, text, extensions.citext, uuid[]) to anon, authenticated;

grant execute on function app.create_officer_invitation(
  uuid, public.officer_role, text, jsonb, text, text, extensions.citext
) to authenticated;
grant execute on function app.revoke_officer_invitation(uuid) to authenticated;
grant execute on function app.accept_officer_invitation(text) to authenticated;
grant execute on function app.decline_officer_invitation(text) to authenticated;

grant execute on function app.end_officer_term(uuid, text) to authenticated;
