-- ─────────────────────────────────────────────────────────────────────────────
-- 20260920170000 — "Find yourself": public member identification
--
-- A managed collection asks a named list of people for money. The contributor
-- opening its link has no account and no session, and the page has to work out
-- which member they are before it can show what they are expected to pay.
--
-- That is a search over a community's roll, exposed to `anon`, which is the
-- most security-sensitive surface in the product so far. The rules it follows:
--
--   SCOPE.       A lookup happens inside ONE collection. The candidate set is
--                app.resolve_collection_audience — which already excludes
--                archived and merged members and already enforces group and
--                selected-member rules, so this function cannot disagree with
--                who the collection is for.
--
--   NO BROWSING. Every match is an EQUALITY on something the person already
--                knows: their member code, a unique attribute (matric number,
--                house number), their phone, their email. The one fuzzy path is
--                a name, and it needs at least two name parts. There is no
--                prefix search, no wildcard, and no "list members" path at all.
--
--   NO LEAKING.  One match returns that person's own identity. SEVERAL matches
--                return a COUNT and the name of a field that would tell them
--                apart — no ids, no names, no identifiers. Disambiguation is
--                the contributor typing something more specific, never the page
--                showing them a list of their neighbours.
--
--   NO PRIVATE FIELDS. What comes back is the name, the member code and the
--                community's primary identifier. Not the phone, not the email,
--                not any other attribute, not the status, not the obligations
--                of anyone but the identified member.
--
-- Nothing here writes. Nothing here marks anything paid. There is no
-- contributions table to write to and there will not be one in this phase
-- (ADR 0006, ADR 0012).
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Which collections accept an identification at all ────────────────────────
-- The same gate as the public page (SEC-12), plus: the collection must have a
-- member list to identify against, and must still be taking contributions.
create or replace function app.collection_accepts_identification(p_collection_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.collections c
    join public.communities com on com.id = c.community_id
    where c.id = p_collection_id
      and c.status in ('active', 'paused')
      and c.visibility in ('public', 'unlisted')
      and c.audience_mode <> 'public'
      and com.status = 'active'
  );
$$;

comment on function app.collection_accepts_identification(uuid) is
  'True when a collection has a member list to identify against and is still open. A draft, a closed collection, a members-only one and an open public one all answer false — and all answer it the same way, so the caller learns nothing about which.';

revoke all on function app.collection_accepts_identification(uuid) from public;


-- ── The lookup ───────────────────────────────────────────────────────────────
create or replace function app.find_collection_member(
  p_collection_id uuid,
  p_query         text
)
returns table (
  match_status     text,     -- 'none' | 'one' | 'many'
  member_id        uuid,     -- only for 'one'
  full_name        text,     -- only for 'one'
  member_code      text,     -- only for 'one'
  identifier_label text,     -- the community's primary identifier field, if any
  identifier_value text,     -- only for 'one'
  match_count      integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_community_id uuid;
  v_query        text;
  v_digits       text;
  v_tokens       text[];
  v_primary_id   uuid;
  v_primary_label text;
  v_matches      uuid[];
  v_count        integer;
  v_member       public.members%rowtype;
begin
  v_query := lower(trim(coalesce(p_query, '')));

  -- Short queries are refused rather than answered. "ad" would match a great
  -- many people, and an answer of "several" to a two-letter query is itself a
  -- way to map a roll.
  if char_length(v_query) < 3 then
    raise exception 'QUERY_TOO_SHORT: type at least 3 characters' using errcode = 'P0001';
  end if;
  if char_length(v_query) > 120 then
    raise exception 'QUERY_TOO_LONG: that is too long to be a name or an ID' using errcode = 'P0001';
  end if;

  if not app.collection_accepts_identification(p_collection_id) then
    -- Deliberately indistinguishable from "nobody matched": a caller must not
    -- be able to tell a draft collection from an empty search.
    return query select 'none'::text, null::uuid, null::text, null::text, null::text, null::text, 0;
    return;
  end if;

  select community_id into v_community_id from public.collections where id = p_collection_id;

  select id, label into v_primary_id, v_primary_label
  from public.member_attribute_definitions
  where community_id = v_community_id and is_primary_identifier;

  -- Digits only, for a phone typed as +234 801 111 2222 or 08011112222.
  v_digits := regexp_replace(v_query, '[^0-9]', '', 'g');
  v_tokens := array_remove(string_to_array(regexp_replace(v_query, '\s+', ' ', 'g'), ' '), '');

  select array_agg(m.id) into v_matches
  from public.members m
  where m.community_id = v_community_id
    -- The audience decides who exists here. Archived, merged, and anyone
    -- outside the chosen groups or the selected list are simply not candidates.
    and m.id in (select a.member_id from app.resolve_collection_audience(p_collection_id) a)
    and (
      -- The member code, exactly.
      lower(m.member_code) = v_query

      -- Any attribute the community declared unique — its primary identifier,
      -- and anything else it decided must not repeat. Exactly, never partially.
      or exists (
        select 1
        from public.member_attribute_values mav
        where mav.member_id = m.id
          and mav.is_unique
          and mav.value_norm = v_query
      )

      -- Contact details, exactly. A phone is compared as digits, and the
      -- national leading zero is dropped, so 08011112222 finds the member
      -- stored as +2348011112222 — which is how everyone in Nigeria types it.
      or (
        char_length(v_digits) >= 7
        and regexp_replace(coalesce(m.phone_e164, ''), '[^0-9]', '', 'g')
            like '%' || case when left(v_digits, 1) = '0' then substr(v_digits, 2) else v_digits end
      )
      or lower(m.email::text) = v_query

      -- The name. Either written out exactly, or at least two parts of it,
      -- each of which must begin a part of the stored name. One name part is
      -- not enough to search on: "grace" would return a congregation.
      or lower(m.full_name) = v_query
      or (
        array_length(v_tokens, 1) >= 2
        and not exists (
          select 1
          from unnest(v_tokens) as token
          where not exists (
            select 1
            from unnest(string_to_array(lower(m.full_name), ' ')) as name_part
            where name_part like token || '%'
          )
        )
      )
    );

  v_count := coalesce(array_length(v_matches, 1), 0);

  if v_count = 0 then
    return query select 'none'::text, null::uuid, null::text, null::text, v_primary_label, null::text, 0;
    return;
  end if;

  if v_count > 1 then
    -- Several people answer to this. They are not listed: the contributor is
    -- asked for something that tells them apart, and the only thing that
    -- travels back is how many there were and what to type next.
    return query select 'many'::text, null::uuid, null::text, null::text, v_primary_label, null::text, least(v_count, 99);
    return;
  end if;

  select * into v_member from public.members where id = v_matches[1];

  return query
  select
    'one'::text,
    v_member.id,
    v_member.full_name,
    v_member.member_code,
    v_primary_label,
    (
      select mav.value_text
      from public.member_attribute_values mav
      where mav.member_id = v_member.id and mav.definition_id = v_primary_id
    ),
    1;
end;
$$;

comment on function app.find_collection_member(uuid, text) is
  'SEC-12 / §3 of M7: contributor self-identification, scoped to one collection''s audience. Equality matching on what the person already knows; a name needs two parts. Several matches return a count and nothing else — never a list of candidates.';


-- ── What the identified member is being asked for ────────────────────────────
-- Called after the contributor has confirmed "yes, this is me". Re-derives
-- everything: that the collection still accepts identification, that this member
-- is still in its audience, and what they owe for the period in question.
--
-- A member id is not a capability by itself — it only answers here, for this
-- collection, and only with what the contributor needs in order to pay.
create or replace function app.get_collection_member_context(
  p_collection_id uuid,
  p_member_id     uuid
)
returns table (
  member_id            uuid,
  full_name            text,
  member_code          text,
  identifier_label     text,
  identifier_value     text,
  obligation_id        uuid,
  cycle_key            text,
  cycle_label          text,
  expected_amount_kobo bigint,
  waived_amount_kobo   bigint,
  obligation_status    public.obligation_status,
  due_at               timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_community_id uuid;
  v_schedule     public.collection_schedule;
  v_cycle        public.collection_cycles%rowtype;
  v_primary_id   uuid;
  v_primary_label text;
begin
  if not app.collection_accepts_identification(p_collection_id) then
    return;  -- No rows. The caller cannot tell this from "not that member".
  end if;

  select community_id, schedule into v_community_id, v_schedule
  from public.collections where id = p_collection_id;

  -- Still eligible, checked now rather than remembered from the lookup: a
  -- member archived between the two calls stops being able to continue.
  if not exists (
    select 1 from app.resolve_collection_audience(p_collection_id) a where a.member_id = p_member_id
  ) then
    return;
  end if;

  select id, label into v_primary_id, v_primary_label
  from public.member_attribute_definitions
  where community_id = v_community_id and is_primary_identifier;

  -- A recurring collection is asking about one period: the open one.
  if v_schedule = 'recurring' then
    select * into v_cycle
    from public.collection_cycles
    where collection_id = p_collection_id and closed_at is null
    order by period_start desc
    limit 1;
  end if;

  return query
  select
    m.id,
    m.full_name,
    m.member_code,
    v_primary_label,
    (
      select mav.value_text
      from public.member_attribute_values mav
      where mav.member_id = m.id and mav.definition_id = v_primary_id
    ),
    o.id,
    o.cycle_key,
    -- The period as a person says it: "1 Oct 2026 – 31 Oct 2026".
    case when v_cycle.id is null then null
         else to_char(v_cycle.period_start, 'DD Mon YYYY') || ' – ' || to_char(v_cycle.period_end, 'DD Mon YYYY')
    end,
    -- Cast out of the app.kobo domain: RETURN QUERY matches the declared
    -- return type exactly, and a domain is not its base type to that check.
    o.expected_amount_kobo::bigint,
    o.waived_amount_kobo::bigint,
    o.status,
    o.due_at
  from public.members m
  left join public.obligations o
    on o.collection_id = p_collection_id
   and o.member_id = m.id
   and o.status <> 'cancelled'
   and (v_schedule <> 'recurring' or o.cycle_key is not distinct from v_cycle.cycle_key)
  where m.id = p_member_id;
end;
$$;

comment on function app.get_collection_member_context(uuid, uuid) is
  'What an identified contributor is being asked for: their own name, code and primary identifier, plus their obligation for the period in question. Eligibility is re-checked here, so a member archived after the lookup cannot continue. Returns nothing rather than an error when the answer is no — a refusal that names its reason is a fact about somebody else.';
