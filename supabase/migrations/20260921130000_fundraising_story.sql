-- ─────────────────────────────────────────────────────────────────────────────
-- 20260921130000 — A fundraiser's story
--
-- §5/§19: the previous fundraising creation experience was, in the brief's own
-- words, "fixed collection + description + target field" — the current
-- codebase's "Fundraiser" intent is exactly that today (open_amount + a
-- generic description textarea + a target). The legacy product's fundraising
-- wizard asked three separate, guided questions instead of one free-text box
-- ("what is this for", "why does this matter", "what impact will donations
-- have") — reviewed in docs/history/2026-09-21-collection-creation-audit-and-
-- architecture.md §2, and worth keeping: a guided structure produces a more
-- readable campaign than an organiser staring at one blank textarea.
--
-- These are separate columns from `description` rather than a replacement for
-- it, because `description` is generic — every collection type has one — and
-- a fundraiser's story is specifically fundraising's own shape. A tiered
-- collection or a dues collection gets no story fields and no story section on
-- its public page; the columns are simply null.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.collections
  add column story_what   text,
  add column story_why    text,
  add column story_impact text;

alter table public.collections
  add constraint collections_story_what_length   check (story_what   is null or char_length(story_what)   <= 2000),
  add constraint collections_story_why_length    check (story_why    is null or char_length(story_why)    <= 2000),
  add constraint collections_story_impact_length check (story_impact is null or char_length(story_impact) <= 2000);

comment on column public.collections.story_what is
  '§5/§19. What the fundraiser is for. Fundraising only — null on every other category.';
comment on column public.collections.story_why is
  '§5/§19. Why it matters. Fundraising only.';
comment on column public.collections.story_impact is
  '§5/§19. What a donation actually buys. Fundraising only.';

-- ── Setting it ───────────────────────────────────────────────────────────────
create or replace function app.set_collection_story(
  p_collection_id uuid,
  p_story_what    text default null,
  p_story_why     text default null,
  p_story_impact  text default null
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

  if v_collection.status in ('closed', 'archived', 'suspended') then
    raise exception 'COLLECTION_NOT_EDITABLE: a % collection cannot be edited', v_collection.status
      using errcode = 'P0001';
  end if;
  if v_collection.category <> 'fundraiser' then
    raise exception 'NOT_FUNDRAISER: only a fundraiser has a story' using errcode = 'P0001';
  end if;
  if length(coalesce(p_story_what, ''))   > 2000
     or length(coalesce(p_story_why, ''))    > 2000
     or length(coalesce(p_story_impact, '')) > 2000 then
    raise exception 'STORY_TOO_LONG: each part of the story is at most 2000 characters' using errcode = 'P0001';
  end if;

  update public.collections set
    story_what   = nullif(trim(coalesce(p_story_what, '')), ''),
    story_why    = nullif(trim(coalesce(p_story_why, '')), ''),
    story_impact = nullif(trim(coalesce(p_story_impact, '')), '')
  where id = p_collection_id;

  perform app.write_audit_log(
    v_collection.community_id, 'officer', auth.uid(), 'collection.set_story', 'collection', p_collection_id,
    null, jsonb_build_object('set', true)
  );
end;
$$;

comment on function app.set_collection_story is
  '§5/§19. A fundraiser''s story — what it is for, why it matters, what it funds. Refused on any collection that is not category=fundraiser.';

revoke execute on function app.set_collection_story(uuid, text, text, text) from public;
grant  execute on function app.set_collection_story(uuid, text, text, text) to authenticated;

-- ── Reading it back, officer side (SettingsPanel) ───────────────────────────
-- The officer read already goes through a plain `select *` via RLS (see
-- app.require_permission-gated policies on public.collections), so no new
-- function is needed there — only the public, anonymous-facing read below.

-- ── get_public_collection, replaced again to carry the story ───────────────
drop function if exists app.get_public_collection(text, text);

create or replace function app.get_public_collection(
  p_community_slug  text,
  p_collection_slug text
)
returns table (
  collection_id        uuid,
  collection_name      text,
  description          text,
  cover_image_url      text,
  category             public.collection_category,
  participation_mode   public.participation_mode,
  audience_mode        public.collection_audience_mode,
  amount_model         public.amount_model,
  payment_plan         public.payment_plan,
  fixed_amount_kobo    bigint,
  min_amount_kobo      bigint,
  max_amount_kobo      bigint,
  target_amount_kobo   bigint,
  suggested_amounts_kobo bigint[],
  deadline_at          timestamptz,
  event_starts_at      timestamptz,
  event_ends_at        timestamptz,
  venue                text,
  collect_attendee_details boolean,
  story_what           text,
  story_why            text,
  story_impact         text,
  status               public.collection_status,
  display_options      jsonb,
  fee_mode             public.fee_mode,
  thank_you_message    text,
  community_name       text,
  community_logo_url   text,
  community_verified   public.verification_status
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.id, c.name, c.description, c.cover_image_url, c.category,
    c.participation_mode, c.audience_mode, c.amount_model, c.payment_plan,
    c.fixed_amount_kobo, c.min_amount_kobo, c.max_amount_kobo, c.target_amount_kobo,
    c.suggested_amounts_kobo,
    c.deadline_at, c.event_starts_at, c.event_ends_at, c.venue, c.collect_attendee_details,
    c.story_what, c.story_why, c.story_impact,
    c.status, c.display_options, c.fee_mode, c.thank_you_message,
    com.name, com.logo_url, com.verification_status
  from public.collections c
  join public.communities com on com.id = c.community_id
  where com.slug = p_community_slug
    and c.slug   = p_collection_slug
    and c.status in ('active', 'paused', 'closed')
    and c.visibility in ('public', 'unlisted')
    and com.status = 'active';
$$;

comment on function app.get_public_collection(text, text) is
  'SEC-12: the whitelisted public collection page. Carries what a contributor needs to decide — the event, whether it asks for attendee details, a fundraiser''s story, and the amounts it suggests — and nothing about members, officers or money received.';

revoke execute on function app.get_public_collection(text, text) from public;
grant  execute on function app.get_public_collection(text, text) to anon, authenticated;
