-- ─────────────────────────────────────────────────────────────────────────────
-- 20260920140100 — Invitation grants
--
-- Both functions were replaced in 20260920140000 with new signatures, so their
-- old grants went with the old signatures. Restated here, in the one file that
-- decides what a client role can reach (20260917121100).
--
-- `anon` gains one read — app.get_public_invite — alongside the write it
-- already had. Someone opening an invite link has no account and never will:
-- they need to see which community is asking and what it wants to know, and
-- the function returns that and nothing else. The anon allowlist in
-- 02_grant_matrix.sql is updated in the same change.
-- ─────────────────────────────────────────────────────────────────────────────

revoke execute on function app.create_invite_link(
  uuid, uuid[], boolean, boolean, boolean, timestamptz, integer, text, text[], text[]
)                                                                                        from public;
revoke execute on function app.redeem_invite_link(
  text, text, text, extensions.citext, uuid[], jsonb
)                                                                                        from public;
revoke execute on function app.get_public_invite(text)                                   from public;

grant execute on function app.create_invite_link(
  uuid, uuid[], boolean, boolean, boolean, timestamptz, integer, text, text[], text[]
)                                                                                        to authenticated;

-- The one anonymous write in the schema, and now the one anonymous read that
-- serves the page in front of it.
grant execute on function app.redeem_invite_link(
  text, text, text, extensions.citext, uuid[], jsonb
)                                                                                        to anon, authenticated;
grant execute on function app.get_public_invite(text)                                    to anon, authenticated;
