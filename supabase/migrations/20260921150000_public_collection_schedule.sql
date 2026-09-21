-- ─────────────────────────────────────────────────────────────────────────────
-- 20260921150000 — The public page learns whether a collection repeats
--
-- §10: a recurring charge should read as a recurring charge on the public
-- page, not as a one-off contribution with the same layout. `schedule` is the
-- fact that answers it, and it was the one column the page needed that
-- `app.get_public_collection` did not return.
--
-- Built by copying the CURRENT definition (20260921140000) verbatim and
-- adding one column — the discipline this function now requires, after two
-- redefinitions in this session were built from a stale copy and silently
-- dropped `audience_mode` (see 20260921140000's own comment, and the pgTAP
-- test that now guards it).
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
  schedule             public.collection_schedule,
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
    c.participation_mode, c.audience_mode, c.amount_model, c.schedule, c.payment_plan,
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
  'SEC-12: the whitelisted public collection page. Carries what a contributor needs to decide — whether this is for a named list of members, whether it repeats, the event, whether it asks for attendee details, a fundraiser''s story, and the amounts it suggests — and nothing about members, officers or money received.';

revoke execute on function app.get_public_collection(text, text) from public;
grant  execute on function app.get_public_collection(text, text) to anon, authenticated;
