-- ─────────────────────────────────────────────────────────────────────────────
-- 20261116130000 — Collection financial overview, contributor register and
--                  contribution acknowledgement
--
-- Design: docs/product/COLLECTION-FINANCIAL-OVERVIEW-AND-REGISTER.md
--
-- READS, NOT A NEW LEDGER. Every money figure here is read from what already
-- exists: gross from `contributions` (status 'applied'), position from the
-- ledger through `v_collection_position`. Nothing in this file writes a
-- contribution, an attempt, an obligation or a journal.
--
-- WHAT IS NEW
--   1. permission `contribution.acknowledge` (owner, admin, treasurer;
--      collector scoped). Viewer stays read-only.
--   2. table `contribution_acknowledgements` — an organiser's "I have seen and
--      recorded this payment". Its own table because `contributions` is
--      immutable. RLS forced, no client grants, deny-all policy: reachable only
--      through the functions below.
--   3. app.collection_financial_overview(collection)
--   4. app.collection_contributors(collection, search, acknowledged, …)
--   5. app.acknowledge_contributions(collection, ids, as_of)
--
-- CONTRIBUTOR IDENTITY. "The same person" is the member when the payment was
-- made as a saved member, else the checkout email, lower-cased and trimmed.
-- Never the name. The key itself is never returned: it embeds an email address,
-- and contact details need member.view_contact.
--
-- Additive. Rollback: drop the three functions, drop the table, drop the
-- unique index `contributions_id_collection_key`, delete the four
-- role_permissions rows and the permission row.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Permission ──────────────────────────────────────────────────────────

insert into public.permissions (key, description) values
  ('contribution.acknowledge', 'Mark contributions as seen and recorded');

-- Owner received every permission that existed in 20260917120400 through a
-- SELECT over the catalogue; a new key has to be granted to owner explicitly.
insert into public.role_permissions (role, permission, scoped) values
  ('owner',     'contribution.acknowledge', false),
  ('admin',     'contribution.acknowledge', false),
  ('treasurer', 'contribution.acknowledge', false),
  ('collector', 'contribution.acknowledge', true);


-- ── 2. Acknowledgements ────────────────────────────────────────────────────

-- Lets the acknowledgement name its collection in a foreign key, so a row can
-- never claim a contribution of another collection. `id` is already unique;
-- this adds nothing a contribution can violate.
create unique index contributions_id_collection_key
  on public.contributions (id, collection_id);

create table public.contribution_acknowledgements (
  contribution_id  uuid         primary key,
  collection_id    uuid         not null references public.collections (id) on delete restrict,
  community_id     uuid         not null references public.communities (id) on delete restrict,
  acknowledged_by  uuid         references public.users (id) on delete set null,
  acknowledged_at  timestamptz  not null default now(),
  constraint contribution_acknowledgements_contribution_fk
    foreign key (contribution_id, collection_id)
    references public.contributions (id, collection_id) on delete restrict
);

comment on table public.contribution_acknowledgements is
  'An organiser''s confirmation that they have seen and recorded a contribution. Organiser workflow only: it changes no payment, settlement, balance or withdrawal state. Written and read only through app.acknowledge_contributions / app.collection_contributors.';

create index contribution_acknowledgements_collection_idx
  on public.contribution_acknowledgements (collection_id);

-- The community must be the collection's own.
create or replace function app.assert_acknowledgement_is_consistent()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.collections c
    where c.id = new.collection_id and c.community_id = new.community_id
  ) then
    raise exception 'TENANCY_MISMATCH: acknowledgement community does not own collection %', new.collection_id
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke execute on function app.assert_acknowledgement_is_consistent() from public, anon, authenticated;

create trigger contribution_acknowledgements_consistent
  before insert or update on public.contribution_acknowledgements
  for each row execute function app.assert_acknowledgement_is_consistent();

alter table public.contribution_acknowledgements enable row level security;
alter table public.contribution_acknowledgements force  row level security;

-- Deliberate: no client reads the table directly (SEC-14 — money-adjacent
-- records are served through permission-checked functions).
create policy contribution_acknowledgements_no_client_read
  on public.contribution_acknowledgements for select to authenticated
  using (false);

revoke all on public.contribution_acknowledgements from anon, authenticated;


-- ── 3. Financial overview ──────────────────────────────────────────────────
--
-- total_raised   Σ contribution_kobo, applied contributions (gross, before
--                fees — D-30's definition of "raised")
-- fees_deducted  Σ (contribution_kobo − net_kobo): fees the organiser bore
-- pending … withdrawn   the collection's ledger accounts (v_collection_position)
--
-- By construction of the capture journals,
--   total_raised − fees_deducted = pending + available + on_hold
--                                  + withdrawing + withdrawn (+ chargeback,
--                                  refund_reserve once those are written)
-- Balances are returned only to callers holding balance.view; the rest needs
-- transaction.view on the collection.

create or replace function app.collection_financial_overview(p_collection_id uuid)
returns table (
  total_raised_kobo      app.kobo,
  fees_deducted_kobo     app.kobo,
  net_raised_kobo        app.kobo,
  contribution_count     integer,
  contributor_count      integer,
  acknowledged_count     integer,
  under_review_count     integer,
  last_contribution_at   timestamptz,
  can_view_balances      boolean,
  pending_kobo           app.kobo,
  available_kobo         app.kobo,
  on_hold_kobo           app.kobo,
  withdrawing_kobo       app.kobo,
  withdrawn_kobo         app.kobo
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
  v_balances   boolean;
begin
  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  if not app.has_permission_for_collection(p_collection_id, 'transaction.view') then
    raise exception 'FORBIDDEN: missing permission transaction.view for collection %', p_collection_id
      using errcode = '42501';
  end if;
  v_balances := app.has_permission_for_collection(p_collection_id, 'balance.view');

  return query
  with paid as (
    select
      c.id,
      c.contribution_kobo,
      c.net_kobo,
      c.captured_at,
      case when c.member_id is not null then 'member:' || c.member_id::text
           else 'email:' || lower(btrim(i.contributor_email)) end as person
    from public.contributions c
    join public.payment_attempts a on a.id = c.attempt_id
    join public.contribution_intents i on i.id = a.intent_id
    where c.collection_id = p_collection_id
      and c.status = 'applied'
  ),
  pos_row as (
    select * from public.v_collection_position p where p.collection_id = p_collection_id
  )
  select
    coalesce((select sum(p.contribution_kobo) from paid p), 0)::app.kobo,
    coalesce((select sum(p.contribution_kobo - p.net_kobo) from paid p), 0)::app.kobo,
    coalesce((select sum(p.net_kobo) from paid p), 0)::app.kobo,
    (select count(*)::integer from paid),
    (select count(distinct p.person)::integer from paid p),
    (select count(*)::integer from public.contribution_acknowledgements k
       join paid p on p.id = k.contribution_id),
    (select count(*)::integer from public.payment_attempts a
       where a.collection_id = p_collection_id and a.status = 'needs_review'),
    (select max(p.captured_at) from paid p),
    v_balances,
    (case when v_balances then (select pos.pending_kobo     from pos_row pos) end)::app.kobo,
    (case when v_balances then (select pos.available_kobo   from pos_row pos) end)::app.kobo,
    (case when v_balances then (select pos.on_hold_kobo     from pos_row pos) end)::app.kobo,
    (case when v_balances then (select pos.withdrawing_kobo from pos_row pos) end)::app.kobo,
    (case when v_balances then (select pos.withdrawn_kobo   from pos_row pos) end)::app.kobo;
end;
$$;

comment on function app.collection_financial_overview(uuid) is
  'One collection''s money and contributor counts, read from contributions (gross) and the ledger (position). Needs transaction.view; balances are null unless the caller holds balance.view. Writes nothing.';

revoke all     on function app.collection_financial_overview(uuid) from public;
grant  execute on function app.collection_financial_overview(uuid) to authenticated;


-- ── 4. Contributor register ────────────────────────────────────────────────
--
-- One row per applied contribution — never an attempt, so failed, abandoned,
-- pending and under-review payments never appear. Paged here (limit ≤ 200).
-- Email and phone are returned only when asked for AND the caller holds
-- member.view_contact. Money in `lines` is a string of kobo, never a JSON
-- number (ADR 0003).

create or replace function app.collection_contributors(
  p_collection_id    uuid,
  p_search           text    default null,
  p_acknowledged     boolean default null,
  p_include_contact  boolean default false,
  p_limit            integer default 50,
  p_offset           integer default 0,
  p_contribution_ids uuid[]  default null
)
returns table (
  contribution_id            uuid,
  captured_at                timestamptz,
  contribution_kobo          app.kobo,
  total_charged_kobo         app.kobo,
  reference                  text,
  contributor_name           text,
  is_member                  boolean,
  member_code                text,
  email                      text,
  phone                      text,
  answers                    jsonb,
  attendee_names             text[],
  lines                      jsonb,
  cycle_key                  text,
  contributor_payment_count  integer,
  contributor_total_kobo     app.kobo,
  acknowledged_at            timestamptz,
  acknowledged_by_name       text,
  total_count                integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
  v_pattern    text;
  v_limit      integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset     integer := greatest(coalesce(p_offset, 0), 0);
begin
  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  if not app.has_permission_for_collection(p_collection_id, 'transaction.view') then
    raise exception 'FORBIDDEN: missing permission transaction.view for collection %', p_collection_id
      using errcode = '42501';
  end if;

  if coalesce(p_include_contact, false)
     and not app.has_permission_for_collection(p_collection_id, 'member.view_contact') then
    raise exception 'FORBIDDEN: missing permission member.view_contact for collection %', p_collection_id
      using errcode = '42501';
  end if;

  if p_contribution_ids is not null and coalesce(array_length(p_contribution_ids, 1), 0) > 200 then
    raise exception 'INVALID: at most 200 contributions per request' using errcode = '22023';
  end if;

  -- Equality-free substring search with LIKE metacharacters escaped, so "%"
  -- typed into the box is a percent sign rather than "everyone".
  if nullif(btrim(coalesce(p_search, '')), '') is not null then
    v_pattern := '%' || replace(replace(replace(left(btrim(p_search), 100), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
  with paid as (
    select
      c.id,
      c.captured_at,
      c.created_at,
      c.contribution_kobo,
      c.total_charged_kobo,
      c.member_id,
      c.cycle_key,
      a.reference,
      i.contributor_name,
      i.contributor_email,
      i.contributor_phone,
      i.answers,
      i.attendee_names,
      case when c.member_id is not null then 'member:' || c.member_id::text
           else 'email:' || lower(btrim(i.contributor_email)) end as person
    from public.contributions c
    join public.payment_attempts a on a.id = c.attempt_id
    join public.contribution_intents i on i.id = a.intent_id
    where c.collection_id = p_collection_id
      and c.status = 'applied'
  ),
  -- Per person across the whole collection, before any filter narrows it.
  people as (
    select p.person, count(*)::integer as payments, sum(p.contribution_kobo) as total
    from paid p
    group by p.person
  ),
  filtered as (
    select
      p.*,
      m.full_name  as member_name,
      m.member_code,
      k.acknowledged_at,
      u.full_name  as acknowledged_by_name,
      pe.payments,
      pe.total
    from paid p
    join people pe on pe.person = p.person
    left join public.members m on m.id = p.member_id
    left join public.contribution_acknowledgements k on k.contribution_id = p.id
    left join public.users u on u.id = k.acknowledged_by
    where (p_contribution_ids is null or p.id = any(p_contribution_ids))
      and (p_acknowledged is null or (k.contribution_id is not null) = p_acknowledged)
      and (
        v_pattern is null
        or coalesce(m.full_name, p.contributor_name) ilike v_pattern
        or p.contributor_name ilike v_pattern
        or p.reference ilike v_pattern
        or coalesce(m.member_code, '') ilike v_pattern
        or exists (select 1 from jsonb_each_text(p.answers) e where e.value ilike v_pattern)
      )
  )
  select
    f.id,
    f.captured_at,
    f.contribution_kobo::app.kobo,
    f.total_charged_kobo::app.kobo,
    f.reference,
    coalesce(f.member_name, f.contributor_name),
    f.member_id is not null,
    f.member_code,
    case when coalesce(p_include_contact, false) then f.contributor_email::text end,
    case when coalesce(p_include_contact, false) then f.contributor_phone end,
    f.answers,
    f.attendee_names,
    coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'kind',        case when l.tier_id is not null then 'tier' else 'item' end,
                 'name',        coalesce(t.name, it.name),
                 'quantity',    l.quantity,
                 'amount_kobo', l.amount_kobo::text)
               order by l.line_no)
      from public.contribution_lines l
      left join public.collection_tiers t on t.id = l.tier_id
      left join public.collection_items it on it.id = l.item_id
      where l.contribution_id = f.id
    ), '[]'::jsonb),
    f.cycle_key,
    f.payments,
    f.total::app.kobo,
    f.acknowledged_at,
    f.acknowledged_by_name,
    (count(*) over ())::integer
  from filtered f
  order by f.captured_at desc, f.id desc
  limit v_limit offset v_offset;
end;
$$;

comment on function app.collection_contributors(uuid, text, boolean, boolean, integer, integer, uuid[]) is
  'The contributor register: one row per applied contribution of one collection, newest first, paged. Needs transaction.view; email/phone only with include_contact and member.view_contact. Same person = member, else checkout email — never the name.';

revoke all     on function app.collection_contributors(uuid, text, boolean, boolean, integer, integer, uuid[]) from public;
grant  execute on function app.collection_contributors(uuid, text, boolean, boolean, integer, integer, uuid[]) to authenticated;


-- ── 5. Acknowledge ─────────────────────────────────────────────────────────
--
-- p_contribution_ids set   acknowledge those (only if they belong here)
-- p_contribution_ids null  acknowledge every not-yet-acknowledged contribution
--                          that appeared at or before p_as_of — the moment the
--                          organiser's screen was loaded, so a payment landing
--                          while they look is not acknowledged unseen.
-- Idempotent; returns how many were newly acknowledged.

create or replace function app.acknowledge_contributions(
  p_collection_id    uuid,
  p_contribution_ids uuid[],
  p_as_of            timestamptz default null
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
  v_count      integer;
begin
  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  if not app.has_permission_for_collection(p_collection_id, 'contribution.acknowledge') then
    raise exception 'FORBIDDEN: missing permission contribution.acknowledge for collection %', p_collection_id
      using errcode = '42501';
  end if;

  if p_contribution_ids is null and p_as_of is null then
    raise exception 'INVALID: acknowledging everything needs the time the list was loaded' using errcode = '22023';
  end if;
  if p_contribution_ids is not null and coalesce(array_length(p_contribution_ids, 1), 0) > 1000 then
    raise exception 'INVALID: at most 1000 contributions per request' using errcode = '22023';
  end if;

  with inserted as (
    insert into public.contribution_acknowledgements (contribution_id, collection_id, community_id, acknowledged_by)
    select c.id, c.collection_id, c.community_id, auth.uid()
    from public.contributions c
    where c.collection_id = p_collection_id
      and c.status = 'applied'
      and (
        (p_contribution_ids is not null and c.id = any(p_contribution_ids))
        or (p_contribution_ids is null and c.created_at <= p_as_of)
      )
    on conflict (contribution_id) do nothing
    returning 1
  )
  select count(*)::integer into v_count from inserted;

  if v_count > 0 then
    perform app.write_audit_log(
      v_collection.community_id, 'officer', auth.uid(),
      'contribution.acknowledge', 'collection', p_collection_id,
      null,
      jsonb_build_object('count', v_count, 'all', p_contribution_ids is null),
      null);
  end if;

  return v_count;
end;
$$;

comment on function app.acknowledge_contributions(uuid, uuid[], timestamptz) is
  'Marks contributions of one collection as seen by an organiser. Needs contribution.acknowledge (collector scope honoured). Idempotent. Touches no payment, settlement, balance or withdrawal record.';

revoke all     on function app.acknowledge_contributions(uuid, uuid[], timestamptz) from public;
grant  execute on function app.acknowledge_contributions(uuid, uuid[], timestamptz) to authenticated;
