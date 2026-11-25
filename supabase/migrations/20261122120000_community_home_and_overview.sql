-- ─────────────────────────────────────────────────────────────────────────────
-- 20261122120000 — Community home, community overview report, recent activity,
--                  verification readiness, personal identity summary
--
-- Design: docs/product/COMMUNITY-EXPERIENCE-PROFILE-KYC-OVERVIEW.md
--
-- READS ONLY. Nothing here writes a row, posts a journal, or changes a
-- balance, a withdrawal, a verification status, a policy or a grant on a
-- table. One index is added for the community activity feed.
--
--   app.my_communities()                          signed-in caller
--       One row per community the caller holds an active officer term in:
--       role, verification status, collection counts. Replaces the per-card
--       queries the community home would otherwise need (no N+1).
--
--   app.community_collection_figures(community)   community.view_dashboard
--       One row per collection: the same sources the collection page reads.
--       Gross collected = applied contributions (as collection_financial_overview);
--       balances = v_collection_position (the ledger). Money columns are NULL
--       unless the caller holds transaction.view / balance.view FOR THAT
--       collection (has_permission_for_collection: collector scope honoured).
--
--   app.community_overview(community)             community.view_dashboard
--       Counts plus the SUM of community_collection_figures. A report, never
--       a balance: v_collection_position's own rule is that there is no
--       community-level position and money is never authorised against a
--       community total. Each collection's money stays that collection's.
--
--   app.community_recent_activity(community, n)   community.view_dashboard
--       Latest successful contributions, publications, withdrawals, officer
--       appointments and invite-link joins, each source filtered by the
--       caller's permission (per collection where money is involved). Never an
--       email, phone, payment reference or account number.
--
--   app.community_verification_readiness(community)  community.view_dashboard
--       The real verification status plus a checklist read from real data.
--       Submitting is NOT built (DEC-04/DEC-05); nothing here changes status.
--
--   app.my_identity_summary()                     signed-in caller
--       identity_level, whether the sign-in email is confirmed, account age.
--
-- Rollback: drop the six functions and the index. No data depends on them.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Index: latest contributions across a community ──────────────────────────
create index if not exists contributions_community_captured_idx
  on public.contributions (community_id, captured_at desc);


-- ── 1. Community home ───────────────────────────────────────────────────────

create or replace function app.my_communities()
returns table (
  community_id          uuid,
  slug                  text,
  name                  text,
  type                  public.community_type,
  is_personal           boolean,
  logo_url              text,
  status                public.community_status,
  verification_status   public.verification_status,
  role                  public.officer_role,
  title                 text,
  role_since            timestamptz,
  collection_count      integer,
  live_collection_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'FORBIDDEN: sign in first' using errcode = '42501';
  end if;

  return query
  select
    c.id, c.slug, c.name, c.type, c.is_personal, c.logo_url, c.status, c.verification_status,
    ot.role, ot.title, ot.started_at,
    -- Every officer role holds community.view_dashboard today; the check keeps
    -- this honest if a future role does not.
    case when app.has_permission(c.id, 'community.view_dashboard') then
      (select count(*)::integer from public.collections k where k.community_id = c.id and k.status <> 'archived') end,
    case when app.has_permission(c.id, 'community.view_dashboard') then
      (select count(*)::integer from public.collections k where k.community_id = c.id and k.status = 'active') end
  from public.officer_terms ot
  join public.communities c on c.id = ot.community_id
  where ot.user_id = v_uid
    and ot.ended_at is null
    and ot.started_at <= now()
  order by c.is_personal desc, c.name;
end;
$$;


-- ── 2. Per-collection figures (the single source for the overview) ─────────

create or replace function app.community_collection_figures(p_community_id uuid)
returns table (
  collection_id          uuid,
  slug                   text,
  name                   text,
  status                 public.collection_status,
  target_amount_kobo     bigint,
  published_at           timestamptz,
  created_at             timestamptz,
  can_view_transactions  boolean,
  can_view_balances      boolean,
  collected_kobo         bigint,
  contribution_count     integer,
  collected_30d_kobo     bigint,
  contribution_30d_count integer,
  last_contribution_at   timestamptz,
  pending_kobo           bigint,
  available_kobo         bigint,
  on_hold_kobo           bigint,
  withdrawing_kobo       bigint,
  withdrawn_kobo         bigint,
  open_withdrawal_count  integer,
  paid_withdrawal_count  integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_since timestamptz := now() - interval '30 days';
begin
  -- No existence leak: an unknown community and one the caller has no role in
  -- are refused alike (SEC-18).
  if p_community_id is null or auth.uid() is null
     or not app.has_permission(p_community_id, 'community.view_dashboard') then
    raise exception 'FORBIDDEN: missing permission community.view_dashboard' using errcode = '42501';
  end if;

  return query
  with cols as (
    select
      k.id, k.slug, k.name, k.status, k.target_amount_kobo, k.published_at, k.created_at,
      app.has_permission_for_collection(k.id, 'transaction.view') as tx,
      app.has_permission_for_collection(k.id, 'balance.view')     as bal
    from public.collections k
    where k.community_id = p_community_id
  ),
  paid as (
    -- Same rows as collection_financial_overview.total_raised_kobo: a
    -- contribution exists only for a verified capture; pending, failed,
    -- abandoned and under-review attempts never produce one.
    select
      t.collection_id,
      sum(t.contribution_kobo)::bigint                                            as s,
      count(*)::integer                                                           as n,
      coalesce(sum(t.contribution_kobo) filter (where t.captured_at >= v_since), 0)::bigint as s30,
      (count(*) filter (where t.captured_at >= v_since))::integer                as n30,
      max(t.captured_at)                                                          as last_at
    from public.contributions t
    where t.community_id = p_community_id
      and t.status = 'applied'
    group by t.collection_id
  ),
  pos as (
    select p.collection_id, p.pending_kobo, p.available_kobo, p.on_hold_kobo, p.withdrawing_kobo, p.withdrawn_kobo
    from public.v_collection_position p
    where p.community_id = p_community_id
  ),
  wd as (
    select
      w.collection_id,
      (count(*) filter (where w.status in ('requested', 'approved', 'processing')))::integer as open_n,
      (count(*) filter (where w.status = 'paid'))::integer                                   as paid_n
    from public.withdrawals w
    where w.community_id = p_community_id
    group by w.collection_id
  )
  select
    c.id, c.slug, c.name, c.status, c.target_amount_kobo::bigint, c.published_at, c.created_at,
    c.tx, c.bal,
    case when c.tx then coalesce(pd.s, 0)   end,
    case when c.tx then coalesce(pd.n, 0)   end,
    case when c.tx then coalesce(pd.s30, 0) end,
    case when c.tx then coalesce(pd.n30, 0) end,
    case when c.tx then pd.last_at          end,
    case when c.bal then coalesce(ps.pending_kobo, 0)::bigint     end,
    case when c.bal then coalesce(ps.available_kobo, 0)::bigint   end,
    case when c.bal then coalesce(ps.on_hold_kobo, 0)::bigint     end,
    case when c.bal then coalesce(ps.withdrawing_kobo, 0)::bigint end,
    case when c.bal then coalesce(ps.withdrawn_kobo, 0)::bigint   end,
    case when c.bal then coalesce(w.open_n, 0) end,
    case when c.bal then coalesce(w.paid_n, 0) end
  from cols c
  left join paid pd on pd.collection_id = c.id
  left join pos  ps on ps.collection_id = c.id
  left join wd   w  on w.collection_id  = c.id
  order by pd.last_at desc nulls last, c.created_at desc;
end;
$$;


-- ── 3. Community overview: counts + the sum of the rows above ───────────────

create or replace function app.community_overview(p_community_id uuid)
returns table (
  members_count            integer,
  members_confirmed_count  integer,
  members_waiting_count    integer,
  officer_count            integer,
  collection_count         integer,
  live_collection_count    integer,
  draft_collection_count   integer,
  upcoming_or_paused_count integer,
  closed_collection_count  integer,
  can_view_transactions    boolean,
  collected_kobo           bigint,
  contribution_count       integer,
  collected_30d_kobo       bigint,
  contribution_30d_count   integer,
  last_contribution_at     timestamptz,
  can_view_balances        boolean,
  balance_kobo             bigint,
  pending_kobo             bigint,
  available_kobo           bigint,
  on_hold_kobo             bigint,
  withdrawing_kobo         bigint,
  withdrawn_kobo           bigint,
  open_withdrawal_count    integer,
  paid_withdrawal_count    integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_tx  boolean;
  v_bal boolean;
begin
  if p_community_id is null or auth.uid() is null
     or not app.has_permission(p_community_id, 'community.view_dashboard') then
    raise exception 'FORBIDDEN: missing permission community.view_dashboard' using errcode = '42501';
  end if;
  -- Community-level holders; the sums below still include only the
  -- collections the caller holds the permission for (collector scope).
  v_tx  := app.has_permission(p_community_id, 'transaction.view');
  v_bal := app.has_permission(p_community_id, 'balance.view');

  return query
  with f as (
    select * from app.community_collection_figures(p_community_id)
  )
  select
    (select count(*)::integer from public.members m
       where m.community_id = p_community_id and m.status in ('active', 'unclaimed')),
    (select count(*)::integer from public.members m
       where m.community_id = p_community_id and m.status = 'active'),
    (select count(*)::integer from public.members m
       where m.community_id = p_community_id and m.status in ('invited', 'pending_approval')),
    (select count(*)::integer from public.officer_terms ot
       where ot.community_id = p_community_id and ot.ended_at is null and ot.started_at <= now()),
    (select count(*)::integer from f where f.status <> 'archived'),
    (select count(*)::integer from f where f.status = 'active'),
    (select count(*)::integer from f where f.status = 'draft'),
    (select count(*)::integer from f where f.status in ('scheduled', 'paused')),
    (select count(*)::integer from f where f.status = 'closed'),
    v_tx,
    case when v_tx then (select coalesce(sum(f.collected_kobo), 0)::bigint     from f where f.can_view_transactions) end,
    case when v_tx then (select coalesce(sum(f.contribution_count), 0)::integer from f where f.can_view_transactions) end,
    case when v_tx then (select coalesce(sum(f.collected_30d_kobo), 0)::bigint from f where f.can_view_transactions) end,
    case when v_tx then (select coalesce(sum(f.contribution_30d_count), 0)::integer from f where f.can_view_transactions) end,
    case when v_tx then (select max(f.last_contribution_at) from f where f.can_view_transactions) end,
    v_bal,
    case when v_bal then (select coalesce(sum(f.pending_kobo + f.available_kobo + f.on_hold_kobo + f.withdrawing_kobo), 0)::bigint
                            from f where f.can_view_balances) end,
    case when v_bal then (select coalesce(sum(f.pending_kobo), 0)::bigint     from f where f.can_view_balances) end,
    case when v_bal then (select coalesce(sum(f.available_kobo), 0)::bigint   from f where f.can_view_balances) end,
    case when v_bal then (select coalesce(sum(f.on_hold_kobo), 0)::bigint     from f where f.can_view_balances) end,
    case when v_bal then (select coalesce(sum(f.withdrawing_kobo), 0)::bigint from f where f.can_view_balances) end,
    case when v_bal then (select coalesce(sum(f.withdrawn_kobo), 0)::bigint   from f where f.can_view_balances) end,
    case when v_bal then (select coalesce(sum(f.open_withdrawal_count), 0)::integer from f where f.can_view_balances) end,
    case when v_bal then (select coalesce(sum(f.paid_withdrawal_count), 0)::integer from f where f.can_view_balances) end;
end;
$$;


-- ── 4. Recent activity ──────────────────────────────────────────────────────

create or replace function app.community_recent_activity(p_community_id uuid, p_limit integer default 5)
returns table (
  kind             text,
  occurred_at      timestamptz,
  collection_id    uuid,
  collection_slug  text,
  collection_name  text,
  actor_name       text,
  amount_kobo      bigint,
  detail           text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_members boolean;
begin
  if p_community_id is null or auth.uid() is null
     or not app.has_permission(p_community_id, 'community.view_dashboard') then
    raise exception 'FORBIDDEN: missing permission community.view_dashboard' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 20 then
    raise exception 'INVALID_LIMIT: 1..20' using errcode = '22023';
  end if;
  v_members := app.has_permission(p_community_id, 'member.view_contact');

  return query
  select * from (
    -- Successful contributions, only in collections the caller may see the
    -- transactions of. The name is what collection_payment_activity shows the
    -- same officer: the member's roll name, else the name the payer typed.
    (select 'contribution'::text, t.captured_at, k.id, k.slug, k.name,
            coalesce(m.full_name, i.contributor_name)::text, t.contribution_kobo::bigint, null::text
       from public.contributions t
       join public.collections k        on k.id = t.collection_id
       join public.payment_attempts a   on a.id = t.attempt_id
       join public.contribution_intents i on i.id = a.intent_id
       left join public.members m       on m.id = t.member_id
      where t.community_id = p_community_id
        and t.status = 'applied'
        and app.has_permission_for_collection(k.id, 'transaction.view')
      order by t.captured_at desc
      limit p_limit)
    union all
    (select 'collection_published', k.published_at, k.id, k.slug, k.name, null::text, null::bigint, null::text
       from public.collections k
      where k.community_id = p_community_id and k.published_at is not null
      order by k.published_at desc
      limit p_limit)
    union all
    (select 'withdrawal_requested', w.requested_at, k.id, k.slug, k.name, u.full_name::text,
            w.amount_kobo::bigint, w.status::text
       from public.withdrawals w
       join public.collections k on k.id = w.collection_id
       left join public.users u  on u.id = w.requested_by
      where w.community_id = p_community_id
        and app.has_permission_for_collection(k.id, 'balance.view')
      order by w.requested_at desc
      limit p_limit)
    union all
    (select 'withdrawal_paid', w.paid_at, k.id, k.slug, k.name, null::text, w.amount_kobo::bigint, null::text
       from public.withdrawals w
       join public.collections k on k.id = w.collection_id
      where w.community_id = p_community_id
        and w.paid_at is not null
        and app.has_permission_for_collection(k.id, 'balance.view')
      order by w.paid_at desc
      limit p_limit)
    union all
    (select 'officer_appointed', ot.started_at, null::uuid, null::text, null::text,
            ot.actor_name_snapshot, null::bigint, ot.role::text
       from public.officer_terms ot
      where ot.community_id = p_community_id and ot.started_at <= now() and ot.start_reason <> 'created'
      order by ot.started_at desc
      limit p_limit)
    union all
    (select 'member_joined', m.created_at, null::uuid, null::text, null::text,
            m.full_name::text, null::bigint, m.status::text
       from public.members m
      where v_members
        and m.community_id = p_community_id
        and m.joined_via = 'invite_link'
        and m.status in ('active', 'unclaimed', 'pending_approval')
      order by m.created_at desc
      limit p_limit)
  ) feed
  order by 2 desc
  limit p_limit;
end;
$$;


-- ── 5. Community verification readiness (read-only) ─────────────────────────

create or replace function app.community_verification_readiness(p_community_id uuid)
returns table (
  verification_status            public.verification_status,
  verified_at                    timestamptz,
  can_submit                     boolean,
  has_description                boolean,
  has_location                   boolean,
  contact_verified               boolean,
  owner_email_confirmed          boolean,
  owner_has_verified_payout      boolean,
  unverified_daily_limit_kobo    bigint,
  requested_today_kobo           bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  -- Mirror of request_withdrawal_to_account's D-07 constant, for display only.
  -- The withdrawal function is what enforces it.
  c_daily_limit constant bigint := 100000000;
  v_c       public.communities%rowtype;
  v_submit  boolean;
  v_bal     boolean;
  v_today   date := (now() at time zone 'Africa/Lagos')::date;
begin
  if p_community_id is null or auth.uid() is null
     or not app.has_permission(p_community_id, 'community.view_dashboard') then
    raise exception 'FORBIDDEN: missing permission community.view_dashboard' using errcode = '42501';
  end if;
  select * into v_c from public.communities where id = p_community_id;
  v_submit := app.has_permission(p_community_id, 'community.submit_verification');
  v_bal    := app.has_permission(p_community_id, 'balance.view');

  return query select
    v_c.verification_status,
    v_c.verified_at,
    v_submit,
    coalesce(char_length(btrim(v_c.description)) > 0, false),
    (v_c.location_state is not null or v_c.location_city is not null),
    v_c.contact_verified_at is not null,
    -- About the owners as people: only for the caller who could submit.
    case when v_submit then exists (
      select 1 from public.officer_terms ot
      join auth.users au on au.id = ot.user_id
      where ot.community_id = p_community_id and ot.role = 'owner'
        and ot.ended_at is null and ot.started_at <= now()
        and au.email is not null and au.email_confirmed_at is not null) end,
    case when v_submit then exists (
      select 1 from public.officer_terms ot
      join public.user_bank_accounts b on b.user_id = ot.user_id
      where ot.community_id = p_community_id and ot.role = 'owner'
        and ot.ended_at is null and ot.started_at <= now()
        and b.status = 'verified') end,
    c_daily_limit,
    -- Same predicate as the D-07 check in request_withdrawal_to_account.
    case when v_bal and v_c.verification_status is distinct from 'verified' then (
      select coalesce(sum(w.amount_kobo), 0)::bigint from public.withdrawals w
      where w.community_id = p_community_id
        and (w.requested_at at time zone 'Africa/Lagos')::date = v_today
        and w.status in ('requested', 'approved', 'processing', 'paid', 'reversed')) end;
end;
$$;


-- ── 6. The caller's own identity summary ────────────────────────────────────

create or replace function app.my_identity_summary()
returns table (
  identity_level   public.identity_level,
  email_confirmed  boolean,
  account_created  timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select u.identity_level,
         exists (select 1 from auth.users a where a.id = u.id and a.email_confirmed_at is not null),
         u.created_at
  from public.users u
  where u.id = auth.uid();
$$;


-- ── Grants ──────────────────────────────────────────────────────────────────

revoke all on function app.my_communities()                          from public, anon;
revoke all on function app.community_collection_figures(uuid)        from public, anon;
revoke all on function app.community_overview(uuid)                  from public, anon;
revoke all on function app.community_recent_activity(uuid, integer)  from public, anon;
revoke all on function app.community_verification_readiness(uuid)    from public, anon;
revoke all on function app.my_identity_summary()                     from public, anon;

grant execute on function app.my_communities()                         to authenticated;
grant execute on function app.community_collection_figures(uuid)       to authenticated;
grant execute on function app.community_overview(uuid)                 to authenticated;
grant execute on function app.community_recent_activity(uuid, integer) to authenticated;
grant execute on function app.community_verification_readiness(uuid)   to authenticated;
grant execute on function app.my_identity_summary()                    to authenticated;
