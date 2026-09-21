-- ─────────────────────────────────────────────────────────────────────────────
-- 20260921190100 — A recurring collection says how often
--
-- M7.6 part V: "Recurring should explain what the recurring obligation is,
-- frequency, amount, cycle, due date."
--
-- The published page could say only that a collection repeats, because
-- `app.get_public_collection` returned `schedule` and nothing else about it.
-- "This repeats" is not an answer to "am I about to be charged this every
-- month or every year?", and a contributor who cannot tell does not pay.
--
-- The three columns added come from `collection_recurrences`, which already
-- exists and is already the single place a repeat is described. No new state.
--
-- HOW THIS FILE WAS WRITTEN, because it matters. The body below is the
-- CURRENT definition read back out of the database with pg_get_functiondef,
-- with three columns added and nothing else touched. The last time this
-- function was redefined from an older copy of itself in the repository it
-- silently dropped `audience_mode`, and every open collection in the product
-- started demanding that contributors find themselves on a members list. A
-- SELECT list is not a place to work from memory.
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists app.get_public_collection(text, text);

create or replace function app.get_public_collection(p_community_slug text, p_collection_slug text)
returns table (
  collection_id            uuid,
  collection_name          text,
  description              text,
  cover_image_url          text,
  category                 public.collection_category,
  participation_mode       public.participation_mode,
  audience_mode            public.collection_audience_mode,
  amount_model             public.amount_model,
  schedule                 public.collection_schedule,
  payment_plan             public.payment_plan,
  fixed_amount_kobo        bigint,
  min_amount_kobo          bigint,
  max_amount_kobo          bigint,
  target_amount_kobo       bigint,
  suggested_amounts_kobo   bigint[],
  deadline_at              timestamptz,
  event_starts_at          timestamptz,
  event_ends_at            timestamptz,
  venue                    text,
  collect_attendee_details boolean,
  story_what               text,
  story_why                text,
  story_impact             text,
  status                   public.collection_status,
  display_options          jsonb,
  fee_mode                 public.fee_mode,
  thank_you_message        text,
  community_name           text,
  community_logo_url       text,
  community_verified       public.verification_status,
  -- New in M7.6. Null on every collection that does not repeat.
  recurrence_frequency     public.recurrence_frequency,
  recurrence_interval      integer,
  recurrence_due_after_days integer
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
    com.name, com.logo_url, com.verification_status,
    r.frequency, r.interval_count, r.due_after_days
  from public.collections c
  join public.communities com on com.id = c.community_id
  left join public.collection_recurrences r on r.collection_id = c.id
  where com.slug = p_community_slug
    and c.slug   = p_collection_slug
    -- CON-08: closed, paused and suspended pages still resolve, so a contributor
    -- sees a clear state instead of a 404. Drafts never resolve.
    and c.status in ('active', 'paused', 'closed')
    and c.visibility in ('public', 'unlisted')
    and com.status = 'active';
$$;

comment on function app.get_public_collection(text, text) is
  'SEC-12: the whitelisted public view of a published collection. Drafts never resolve. Includes how often a recurring collection repeats, so the page can say "every month" rather than "this repeats" (M7.6 part V).';

revoke all     on function app.get_public_collection(text, text) from public;
grant  execute on function app.get_public_collection(text, text) to anon, authenticated;
