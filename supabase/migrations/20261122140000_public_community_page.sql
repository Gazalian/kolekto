-- ─────────────────────────────────────────────────────────────────────────────
-- 20261122140000 — Public community page at /[communitySlug] (owner decisions
-- D-H, D-J, 2026-11-22)
--
-- Adds a publish switch and a public-contact switch to communities, the owner-
-- only function that sets them, and two anonymous reads that are the ENTIRE
-- public surface of a community page (same rule as SEC-12 for collections):
--
--   app.get_public_community(slug)              whitelisted identity fields of a
--                                               PUBLISHED, active, non-personal
--                                               community; nothing otherwise.
--   app.get_public_community_collections(slug)  that community's collections with
--                                               visibility = 'public' only, in
--                                               status active / paused / closed.
--
-- Never returned: drafts, `unlisted` (link only) and `members_only`
-- collections, members, officers, officer contact details, verification
-- evidence, bank details, balances or any money figure. Contact details appear
-- only when the owner turned public_contact_visible on.
--
-- D-J: an unverified community may publish; the page shows its verification
-- status as stored. Publishing grants no permission and changes no limit (D-07
-- stays in app.request_withdrawal_to_account, unchanged).
--
-- Existing collection pages (/[communitySlug]/[collectionSlug]) do not depend
-- on publication and are unchanged.
--
-- Financial effect: none. Two columns added with safe defaults (unpublished,
-- contact hidden), so every existing community stays exactly as it is.
--
-- ROLLBACK (local/itest only): drop the three functions; alter table
--   public.communities drop column public_page_published_at, drop column
--   public_contact_visible.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.communities
  add column if not exists public_page_published_at timestamptz,
  add column if not exists public_contact_visible boolean not null default false;

comment on column public.communities.public_page_published_at is
  'D-J: when the owner published the public page at /[slug]; null = not published (the page is a 404).';
comment on column public.communities.public_contact_visible is
  'Owner''s choice to show contact_email / contact_phone_e164 on the public page. Off by default.';

-- ── Owner-only switch ───────────────────────────────────────────────────────
create or replace function app.set_community_public_page(
  p_community_id   uuid,
  p_published      boolean,
  p_contact_visible boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := auth.uid();
  v_community public.communities%rowtype;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;
  if p_published is null or p_contact_visible is null then
    raise exception 'INVALID_INPUT: both switches are required' using errcode = '22023';
  end if;

  select * into v_community from public.communities where id = p_community_id for update;
  -- An unknown community and one the caller does not own look the same.
  if v_community.id is null or not exists (
    select 1 from public.officer_terms t
    where t.community_id = p_community_id
      and t.user_id = v_uid
      and t.role = 'owner'
      and t.ended_at is null
      and t.started_at <= now()
  ) then
    raise exception 'FORBIDDEN: only the community owner can publish its public page' using errcode = '42501';
  end if;

  if v_community.is_personal then
    raise exception 'NOT_ALLOWED: a personal workspace has no public community page' using errcode = 'P0001';
  end if;
  if p_published and v_community.status <> 'active' then
    raise exception 'NOT_ALLOWED: only an active community can publish its page' using errcode = 'P0001';
  end if;

  update public.communities
  set public_page_published_at = case
        when not p_published then null
        else coalesce(v_community.public_page_published_at, now())
      end,
      public_contact_visible = p_contact_visible
  where id = p_community_id;

  perform app.write_audit_log(
    p_community_id, 'officer', v_uid, 'community.set_public_page', 'community', p_community_id,
    jsonb_build_object('published', v_community.public_page_published_at is not null,
                       'contact_visible', v_community.public_contact_visible),
    jsonb_build_object('published', p_published, 'contact_visible', p_contact_visible)
  );
end;
$$;

comment on function app.set_community_public_page(uuid, boolean, boolean) is
  'D-J. Owner only: publishes / unpublishes the public page at /[slug] and chooses whether contact details show on it. Audited.';

revoke all on function app.set_community_public_page(uuid, boolean, boolean) from public, anon;
grant execute on function app.set_community_public_page(uuid, boolean, boolean) to authenticated;

-- ── Anonymous reads ─────────────────────────────────────────────────────────
create or replace function app.get_public_community(p_slug text)
returns table (
  community_id        uuid,
  slug                text,
  name                text,
  type                text,
  description         text,
  logo_url            text,
  location_state      text,
  location_city       text,
  institution         text,
  verification_status text,
  contact_email       text,
  contact_phone_e164  text,
  published_at        timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.id, c.slug, c.name, c.type::text, c.description, c.logo_url,
    c.location_state, c.location_city, c.institution,
    c.verification_status::text,
    case when c.public_contact_visible then c.contact_email::text end,
    case when c.public_contact_visible then c.contact_phone_e164 end,
    c.public_page_published_at
  from public.communities c
  where c.slug = lower(p_slug)
    and c.public_page_published_at is not null
    and c.status = 'active'
    and not c.is_personal
    and c.archived_at is null;
$$;

comment on function app.get_public_community(text) is
  'D-J. The whole anonymous read surface of a community page: whitelisted identity fields of a published, active, non-personal community. Contact details only when the owner chose to show them.';

create or replace function app.get_public_community_collections(p_slug text)
returns table (
  slug              text,
  name              text,
  description       text,
  cover_image_url   text,
  category          text,
  status            text,
  amount_model      text,
  fixed_amount_kobo bigint,
  min_amount_kobo   bigint,
  starts_at         timestamptz,
  deadline_at       timestamptz,
  event_starts_at   timestamptz,
  published_at      timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    col.slug, col.name, col.description, col.cover_image_url, col.category::text,
    col.status::text, col.amount_model::text, col.fixed_amount_kobo, col.min_amount_kobo,
    col.starts_at, col.deadline_at, col.event_starts_at, col.published_at
  from public.collections col
  join public.communities c on c.id = col.community_id
  where c.slug = lower(p_slug)
    and c.public_page_published_at is not null
    and c.status = 'active'
    and not c.is_personal
    and c.archived_at is null
    -- D-H: only collections the officers chose to LIST. Link-only and
    -- members-only collections never appear here.
    and col.visibility = 'public'
    and col.status in ('active', 'paused', 'closed')
  order by
    case col.status when 'active' then 0 when 'paused' then 1 else 2 end,
    col.published_at desc nulls last
  limit 50;
$$;

comment on function app.get_public_community_collections(text) is
  'D-H/D-J. Listed (visibility = public) collections of a published community, for its public page. No money figures.';

revoke all on function app.get_public_community(text) from public;
revoke all on function app.get_public_community_collections(text) from public;
grant execute on function app.get_public_community(text) to anon, authenticated;
grant execute on function app.get_public_community_collections(text) to anon, authenticated;
