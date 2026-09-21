-- ─────────────────────────────────────────────────────────────────────────────
-- 20260921120000 — Whether a ticketed collection collects attendee details
--
-- §18: an organiser selling several tickets in one order may want one name
-- (and a way to reach them) per ticket, not only per buyer — "VIP × 3" then
-- means three people, not one person taking three seats anonymously. This is
-- an event-level decision, the same standing as the event's own date and
-- venue, so it travels with them through `app.set_collection_event`.
--
-- What this does NOT do: persist attendee names anywhere. Nothing in this
-- phase stores a contribution at all (ADR 0006/0012) — the whole contributor
-- flow resolves an amount and shows it back, unstored. Attendee names follow
-- the same rule: collected, validated, shown on the confirmation screen, kept
-- nowhere. A table to hold them belongs to whichever future phase decides how
-- an order is actually recorded, not to this one.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.collections
  add column collect_attendee_details boolean not null default false;

comment on column public.collections.collect_attendee_details is
  '§18. When true, the public contribution form asks for one name per ticket unit ordered rather than only the buyer''s own details. Presentation only — nothing here is persisted (ADR 0012).';

-- ── set_collection_event, replaced to carry the flag ────────────────────────
drop function if exists app.set_collection_event(uuid, timestamptz, timestamptz, text);

create or replace function app.set_collection_event(
  p_collection_id             uuid,
  p_event_starts_at           timestamptz default null,
  p_event_ends_at             timestamptz default null,
  p_venue                     text default null,
  p_collect_attendee_details  boolean default false
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
  if p_event_ends_at is not null and p_event_starts_at is not null and p_event_ends_at < p_event_starts_at then
    raise exception 'INVALID_EVENT_DATES: the event cannot end before it starts' using errcode = 'P0001';
  end if;

  -- Deliberately NOT locked after publication: a venue changes, a date moves,
  -- and telling ticket-holders is exactly what the page is for. The price is
  -- what stays fixed.
  update public.collections set
    event_starts_at          = p_event_starts_at,
    event_ends_at            = p_event_ends_at,
    venue                    = nullif(trim(coalesce(p_venue, '')), ''),
    collect_attendee_details = coalesce(p_collect_attendee_details, false)
  where id = p_collection_id;

  perform app.write_audit_log(
    v_collection.community_id, 'officer', auth.uid(), 'collection.set_event', 'collection', p_collection_id,
    jsonb_build_object('event_starts_at', v_collection.event_starts_at, 'venue', v_collection.venue),
    jsonb_build_object('event_starts_at', p_event_starts_at, 'venue', p_venue)
  );
end;
$$;

comment on function app.set_collection_event is
  'The date, place and attendee-detail setting for a ticketed collection. The date and venue stay editable after publication — a moved venue must be publishable; a changed price must not be.';

revoke execute on function app.set_collection_event(uuid, timestamptz, timestamptz, text, boolean) from public;
grant  execute on function app.set_collection_event(uuid, timestamptz, timestamptz, text, boolean) to authenticated;

-- ── get_public_collection, replaced to expose it to the contribution form ───
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
  'SEC-12: the whitelisted public collection page. Carries what a contributor needs to decide — including the event it is for, whether it asks for attendee details, and the amounts it suggests — and nothing about members, officers or money received.';

revoke execute on function app.get_public_collection(text, text) from public;
grant  execute on function app.get_public_collection(text, text) to anon, authenticated;
