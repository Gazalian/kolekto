-- ---------------------------------------------------------------------------
-- 20260930120000 -- Personal workspace (ensure_personal_workspace)
--
-- Provides an idempotent function that guarantees every user has exactly one
-- personal workspace (is_personal = true, type = 'personal'). Leverages the
-- existing partial unique index communities_one_personal_per_user for
-- database-side duplicate prevention.
--
-- Called during onboarding (any of the three paths: create collection, set up
-- a community, or do this later) and safe to call repeatedly.
-- ---------------------------------------------------------------------------

create or replace function app.ensure_personal_workspace()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id      uuid := auth.uid();
  v_community_id uuid;
  v_actor_name   text;
  v_rows         int;
begin
  if v_user_id is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  -- Fast path: already exists
  select id into v_community_id
  from public.communities
  where created_by = v_user_id and is_personal;

  if v_community_id is not null then
    return v_community_id;
  end if;

  -- Slow path: create
  select full_name into v_actor_name from public.users where id = v_user_id;

  v_community_id := app.uuid_generate_v7();

  insert into public.communities (id, slug, name, type, is_personal, created_by)
  values (
    v_community_id,
    app.generate_unique_community_slug(coalesce(v_actor_name, 'workspace')),
    'My Workspace',
    'personal',
    true,
    v_user_id
  )
  on conflict (created_by) where is_personal do nothing;

  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    -- Race condition: created between our SELECT and INSERT
    select id into v_community_id
    from public.communities
    where created_by = v_user_id and is_personal;
    return v_community_id;
  end if;

  insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason)
  values (v_community_id, v_user_id, 'owner', v_actor_name, 'created');

  return v_community_id;
end;
$$;

comment on function app.ensure_personal_workspace() is
  'Guarantees the calling user has exactly one personal workspace. Idempotent: returns the existing ID if one exists, otherwise creates it with the caller as owner.';

revoke all on function app.ensure_personal_workspace() from public;
grant execute on function app.ensure_personal_workspace() to authenticated;
