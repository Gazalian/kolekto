-- ─────────────────────────────────────────────────────────────────────────────
-- 20260921140000 — Restoring audience_mode to app.get_public_collection
--
-- A real regression, caught by this milestone's own e2e suite rather than
-- shipped: `20260920170100` added `audience_mode` to this function's return
-- table so the public page could tell an open collection from a managed one.
-- The two migrations after it in this session (20260921120000, attendee
-- details; 20260921130000, the fundraiser story) each did the
-- `drop function ... ; create or replace ...` this function requires for a
-- return-type change, but were built from an earlier copy of the function
-- that predated 20260920170100 — so both silently dropped `audience_mode`
-- from the signature. Postgres accepts a redefinition with a different shape
-- without complaint; nothing caught it until the public page started treating
-- every open collection as if `audience_mode` were `undefined`, which is not
-- `'public'`, which sent every contributor to "find yourself on the list"
-- ahead of a contribution form that was never for a named audience at all.
--
-- The fix is mechanical: put `audience_mode` back in the same position
-- 20260920170100 gave it, keep everything the two later migrations added.
-- No column, table or grant changed — only this function's shape, again.
-- ─────────────────────────────────────────────────────────────────────────────

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
    -- CON-08: closed, paused and suspended pages still resolve, so a contributor
    -- sees a clear state instead of a 404. Drafts never resolve.
    and c.status in ('active', 'paused', 'closed')
    and c.visibility in ('public', 'unlisted')
    and com.status = 'active';
$$;

comment on function app.get_public_collection(text, text) is
  'SEC-12: the whitelisted public collection page. Carries what a contributor needs to decide — whether this is for a named list of members, the event, whether it asks for attendee details, a fundraiser''s story, and the amounts it suggests — and nothing about members, officers or money received.';

revoke execute on function app.get_public_collection(text, text) from public;
grant  execute on function app.get_public_collection(text, text) to anon, authenticated;
