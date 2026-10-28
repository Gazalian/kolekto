-- ─────────────────────────────────────────────────────────────────────────────
-- 20261029100100 — Fix: app.count_collection_publish_recipients returns rows
--
-- The function shipped in 20261028100000 (PR #27) ends with a bare
-- `SELECT …` inside a plpgsql block whose `returns table (eligible, unpaid)`
-- signature requires a `RETURN QUERY` or explicit assignment. The current
-- body throws `42601 query has no destination for result data` the moment
-- an authorised caller invokes it:
--
--   with audience as (…), outstanding as (…)
--   select
--     (select count(*)::integer from audience),
--     (select count(*)::integer from audience a where exists (…));
--
-- The publish dialog and the post-publish reminder dialog both call
-- `app.count_collection_publish_recipients(…)` through
-- `previewPublishRecipientsAction`. The server action catches the throw
-- and returns `{ error }`; the dialog renders the preview as
-- "Unknown number of …". The pgTAP suite never covered the function on
-- its own, so the error has gone unseen since PR #27 merged — the e2e
-- `post-publish-reminders.spec.ts` surfaced it (the test asserts on the
-- resolved number, where the publish spec never did).
--
-- Fix: replace the body with `return query with … select …` so the
-- function actually returns the row set it declares. No behaviour change
-- to the SQL that computes the counts — the audience / outstanding CTEs,
-- the obligation statuses and the permission check are preserved exactly.
--
-- Rollback: restore the previous (broken) body from 20261028100000. No
-- schema change, no data touched. `email_sending_enabled` is unaffected.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.count_collection_publish_recipients(p_collection_id uuid)
returns table (eligible integer, unpaid integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_community_id uuid;
begin
  select community_id into v_community_id from public.collections where id = p_collection_id;
  if v_community_id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;
  perform app.require_permission(v_community_id, 'collection.publish');

  return query
  with audience as (
    select a.member_id, m.user_id
    from app.resolve_collection_audience(p_collection_id) a
    join public.members m on m.id = a.member_id
    where m.user_id is not null
  ),
  outstanding as (
    select o.member_id
    from public.obligations o
    where o.collection_id = p_collection_id
      and o.status in ('unpaid', 'in_installments', 'overdue')
  )
  select
    (select count(*)::integer from audience),
    (select count(*)::integer from audience a where exists (select 1 from outstanding s where s.member_id = a.member_id));
end;
$$;

comment on function app.count_collection_publish_recipients(uuid) is
  'M13.3 fix: recipient-preview counts for the publish and reminder dialogs. '
  'eligible = audience members with a linked account (what notify_target=all reaches). '
  'unpaid   = those with an obligation on this collection in (unpaid, in_installments, overdue). '
  'Permission-checked (collection.publish). Reads only. Returns rows via RETURN QUERY.';

-- Grants and privileges are already in place from 20261028100000; nothing to add here.
