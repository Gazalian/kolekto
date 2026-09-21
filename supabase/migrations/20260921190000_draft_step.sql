-- ─────────────────────────────────────────────────────────────────────────────
-- 20260921190000 — Where a draft got to
--
-- M7.6 part A4: "restore the last completed step".
--
-- Everything a draft contains was already saved step by step (M7.5 part A) —
-- the name, the options, the items, the cover, the audience, the questions.
-- What was NOT saved was the one thing that cannot be derived from them:
-- which step the organiser had reached. Guessing it from what is filled in
-- gets it wrong in both directions. A ticketed event with no options yet
-- might be an organiser who has not reached that step, or one who is still
-- deciding; an empty Questions step is indistinguishable from a skipped one,
-- because "no questions" is a legitimate answer.
--
-- So it is a column. One small integer, on the draft it belongs to, written
-- by the same wizard that moves through the steps.
--
-- It means nothing once a collection is published, and nothing reads it then.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.collections
  add column draft_step smallint not null default 0;

alter table public.collections
  add constraint collections_draft_step_range check (draft_step between 0 and 20);

comment on column public.collections.draft_step is
  'M7.6: how far through the creation wizard this draft got, so reopening it lands where the organiser left off. Meaningless once published; nothing reads it then.';


create or replace function app.set_collection_draft_step(
  p_collection_id uuid,
  p_step          smallint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
begin
  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_collection.community_id, 'collection.draft');

  if v_collection.status <> 'draft' then
    -- Not an error worth raising at somebody: a wizard left open in another
    -- tab while the collection was published should quietly do nothing.
    return;
  end if;

  update public.collections
  set draft_step = greatest(least(p_step, 20::smallint), 0::smallint)
  where id = p_collection_id;

  -- No audit entry. Which step a form is on is not a change to the
  -- collection, and an audit log that records every keystroke's worth of
  -- progress is an audit log nobody can read the real events out of (AUD-01).
end;
$$;

comment on function app.set_collection_draft_step(uuid, smallint) is
  'M7.6 part A4: remembers how far through the wizard a draft got. Does nothing once the collection is published. Writes no audit entry — this is form position, not a change to the collection.';

revoke execute on function app.set_collection_draft_step(uuid, smallint) from public;
grant  execute on function app.set_collection_draft_step(uuid, smallint) to authenticated;
