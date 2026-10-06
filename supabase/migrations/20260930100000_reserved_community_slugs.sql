-- ─────────────────────────────────────────────────────────────────────────────
-- 20260930100000 — Reserved community slugs
--
-- M10 safety hardening. Community slugs must never collide with application
-- route segments (BK-02). The reserved set matches APP_SEGMENTS in the
-- middleware (apps/web/lib/supabase/middleware.ts:16).
--
-- Defence in depth: the slug generator skips reserved words, AND a trigger on
-- communities rejects them on INSERT/UPDATE, so no code path can create a
-- collision regardless of how the slug is sourced.
-- ─────────────────────────────────────────────────────────────────────────────

-- The authoritative reserved-slug list. A pure SQL function so both the slug
-- generator and the constraint trigger can reference a single source.
create or replace function app.is_reserved_community_slug(p_slug text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select lower(p_slug) = any(array[
    'c', 'communities', 'login', 'logout', 'invite', 'accept-invite', 'api'
  ]);
$$;

comment on function app.is_reserved_community_slug(text) is
  'M10/BK-02: true when p_slug is an application route segment that must not become a community slug. Kept in the database so the slug generator and the constraint agree on the same list.';

revoke execute on function app.is_reserved_community_slug(text) from public;
grant execute on function app.is_reserved_community_slug(text) to authenticated;


-- Replace the slug generator to skip reserved slugs.
create or replace function app.generate_unique_community_slug(p_name text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_base       text := app.slugify(p_name);
  v_candidate  text := v_base;
  v_suffix     integer := 1;
begin
  loop
    exit when not app.is_reserved_community_slug(v_candidate)
          and not exists (
            select 1 from public.communities where slug = v_candidate
            union all
            select 1 from public.community_slug_history where slug = v_candidate
          );

    v_suffix := v_suffix + 1;
    v_candidate := left(v_base, 50 - length('-' || v_suffix::text)) || '-' || v_suffix::text;

    if v_suffix > 500 then
      raise exception 'SLUG_ALLOCATION_FAILED: could not allocate a unique slug for % after 500 attempts', p_name
        using errcode = 'P0001';
    end if;
  end loop;

  return v_candidate;
end;
$$;


-- Belt-and-suspenders: a trigger on communities rejects reserved slugs on
-- INSERT or UPDATE, regardless of whether they came through the generator.
create or replace function app.assert_community_slug_not_reserved()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if app.is_reserved_community_slug(new.slug) then
    raise exception 'RESERVED_SLUG: "%" is a reserved application route and cannot be used as a community slug', new.slug
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke execute on function app.assert_community_slug_not_reserved() from public;

create trigger communities_slug_not_reserved
  before insert or update of slug on public.communities
  for each row execute function app.assert_community_slug_not_reserved();
