-- ─────────────────────────────────────────────────────────────────────────────
-- 20260917120400 — Roles, officer terms and has_permission
--
-- ADR 0008. This is where authority comes from, and it is the only place.
--
-- The shape that matters: authority is TIME-BOUNDED. A person holds a role in a
-- community for a period, with a start and an end. Removing an officer ends a
-- term; it deletes nothing (OFF-03). That single decision is what makes
-- leadership handover a data operation rather than a migration of ownership,
-- and it is why handover can ship in MVP.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── The permission catalogue ─────────────────────────────────────────────────
-- Named strings (SEC-08), one row per permission, so a new role is a data
-- change rather than a policy rewrite.
create table public.permissions (
  key          text primary key,
  description  text not null,

  constraint permissions_key_format check (key ~ '^[a-z_]+\.[a-z_]+$')
);

insert into public.permissions (key, description) values
  ('community.view_dashboard',      'See the community dashboard and its figures'),
  ('community.edit_profile',        'Edit community name, logo, description, contact'),
  ('community.submit_verification', 'Submit the community for Kolekto verification'),
  ('community.archive',             'Archive the community (read-only, reversible)'),
  ('member.create',                 'Add, import or invite members'),
  ('member.edit',                   'Edit a member record'),
  ('member.archive',                'Archive a member, keeping their history'),
  ('member.view_contact',           'See member phone numbers and email addresses'),
  ('member.export',                 'Export member personal data'),
  ('group.manage',                  'Create groups and move members between them'),
  ('invite.create',                 'Create member invite links'),
  ('invite.approve',                'Approve or reject people who joined via a link'),
  ('collection.draft',              'Create and edit draft collections'),
  ('collection.publish',            'Publish, pause and close a collection'),
  ('collection.change_amount',      'Change amount or target after the first payment'),
  ('collection.share',              'Share links, QR codes and payment details'),
  ('obligation.assign',             'Assign or remove who is expected to pay'),
  ('obligation.exempt',             'Exempt a member or waive part of a balance'),
  ('installment.extend',            'Extend an installment plan deadline'),
  ('announcement.send',             'Announce a collection to members'),
  ('reminder.send',                 'Send payment reminders'),
  ('transaction.view',              'View transactions and contributions'),
  ('balance.view',                  'View balances and withdrawals'),
  ('payment.resolve',               'Resolve payment issues, refund failures and disputes'),
  ('refund.initiate',               'Initiate a refund'),
  ('withdrawal_account.change',     'Add or change the withdrawal bank account'),
  ('withdrawal.request',            'Withdraw money'),
  ('withdrawal.approve',            'Approve a withdrawal above the threshold'),
  ('report.download',               'Download reports and exports'),
  ('audit.view',                    'View the audit log'),
  ('officer.invite',                'Invite officers and change their roles'),
  ('officer.remove_owner',          'Remove an owner'),
  ('handover.initiate',             'Start a leadership handover'),
  ('billing.change',                'Change billing or subscription');

alter table public.permissions enable row level security;
alter table public.permissions force row level security;

comment on table public.permissions is
  'SEC-08: the catalogue of named permissions. Roles map to these in role_permissions.';


-- ── The role matrix ──────────────────────────────────────────────────────────
-- PRD 2.2, encoded. `scoped` marks the cells the matrix shows as "Scope" — a
-- collector holds the permission only within their assigned collections or
-- member groups (ROLE-06, SEC-10). `requires_second_approver` marks the cells
-- shown as "A" (PRD 17.5).
create table public.role_permissions (
  role                     public.officer_role not null,
  permission               text not null references public.permissions (key) on delete restrict,
  scoped                   boolean not null default false,
  requires_second_approver boolean not null default false,
  primary key (role, permission)
);

alter table public.role_permissions enable row level security;
alter table public.role_permissions force row level security;

comment on table public.role_permissions is
  'PRD 2.2 permission matrix as data. ROLE-03: enforced in RLS and in every server function; the UI only mirrors it.';

-- Owner: everything in the catalogue. Two actions still need a second owner.
insert into public.role_permissions (role, permission, requires_second_approver)
select 'owner', key,
       key in ('collection.change_amount', 'refund.initiate',
               'withdrawal_account.change', 'officer.remove_owner',
               'community.archive')
from public.permissions;

-- Admin: runs members, collections and communication. No money, no roles above
-- their own, no verification submission.
insert into public.role_permissions (role, permission) values
  ('admin', 'community.view_dashboard'),
  ('admin', 'community.edit_profile'),
  ('admin', 'member.create'),
  ('admin', 'member.edit'),
  ('admin', 'member.archive'),
  ('admin', 'member.view_contact'),
  ('admin', 'member.export'),
  ('admin', 'group.manage'),
  ('admin', 'invite.create'),
  ('admin', 'invite.approve'),
  ('admin', 'collection.draft'),
  ('admin', 'collection.publish'),
  ('admin', 'collection.share'),
  ('admin', 'obligation.assign'),
  ('admin', 'obligation.exempt'),
  ('admin', 'announcement.send'),
  ('admin', 'reminder.send'),
  ('admin', 'transaction.view'),
  ('admin', 'balance.view'),
  ('admin', 'report.download'),
  ('admin', 'audit.view'),
  ('admin', 'officer.invite');
insert into public.role_permissions (role, permission, requires_second_approver) values
  ('admin', 'collection.change_amount', true);

-- Treasurer: owns money. Cannot change roles or edit the community profile.
insert into public.role_permissions (role, permission) values
  ('treasurer', 'community.view_dashboard'),
  ('treasurer', 'member.create'),
  ('treasurer', 'member.edit'),
  ('treasurer', 'member.archive'),
  ('treasurer', 'member.view_contact'),
  ('treasurer', 'member.export'),
  ('treasurer', 'group.manage'),
  ('treasurer', 'invite.create'),
  ('treasurer', 'invite.approve'),
  ('treasurer', 'collection.draft'),
  ('treasurer', 'collection.publish'),
  ('treasurer', 'collection.share'),
  ('treasurer', 'obligation.assign'),
  ('treasurer', 'obligation.exempt'),
  ('treasurer', 'installment.extend'),
  ('treasurer', 'announcement.send'),
  ('treasurer', 'reminder.send'),
  ('treasurer', 'transaction.view'),
  ('treasurer', 'balance.view'),
  ('treasurer', 'payment.resolve'),
  ('treasurer', 'withdrawal.request'),
  ('treasurer', 'withdrawal.approve'),
  ('treasurer', 'report.download'),
  ('treasurer', 'audit.view'),
  ('treasurer', 'billing.change');
insert into public.role_permissions (role, permission, requires_second_approver) values
  ('treasurer', 'collection.change_amount', true),
  ('treasurer', 'refund.initiate',          true),
  ('treasurer', 'withdrawal_account.change', true);

-- Collector: chases payment within an assigned scope. No money movement at all.
insert into public.role_permissions (role, permission, scoped) values
  ('collector', 'community.view_dashboard', true),
  ('collector', 'member.create',            true),
  ('collector', 'member.edit',              true),
  ('collector', 'member.view_contact',      true),
  ('collector', 'invite.create',            true),
  ('collector', 'collection.share',         true),
  ('collector', 'announcement.send',        true),
  ('collector', 'reminder.send',            true),
  ('collector', 'transaction.view',         true),
  ('collector', 'report.download',          true);

-- Viewer: read-only oversight, including the audit log. RPT-06 withholds
-- contact-detail export unless separately granted.
insert into public.role_permissions (role, permission) values
  ('viewer', 'community.view_dashboard'),
  ('viewer', 'member.view_contact'),
  ('viewer', 'transaction.view'),
  ('viewer', 'balance.view'),
  ('viewer', 'report.download'),
  ('viewer', 'audit.view');


-- ── Leadership terms ─────────────────────────────────────────────────────────
-- HND-01: a named period, for example "2026/2027 Executive". Groups officer
-- terms for reporting and gives the Leadership History page its structure.
create table public.leadership_terms (
  id            uuid primary key default app.uuid_generate_v7(),
  community_id  uuid not null references public.communities (id) on delete cascade,
  name          text not null,
  starts_on     date not null,
  ends_on       date,
  created_at    timestamptz not null default now(),

  constraint leadership_terms_name_length check (char_length(name) between 2 and 80),
  constraint leadership_terms_dates_ordered check (ends_on is null or ends_on >= starts_on)
);

create index leadership_terms_community_idx on public.leadership_terms (community_id, starts_on desc);

alter table public.leadership_terms enable row level security;
alter table public.leadership_terms force row level security;


-- ── Officer terms ────────────────────────────────────────────────────────────
-- OFF-02. The authority record. One person, one role, one community, one period.
create table public.officer_terms (
  id                  uuid primary key default app.uuid_generate_v7(),
  community_id        uuid not null references public.communities (id) on delete cascade,
  user_id             uuid not null references public.users (id)       on delete restrict,
  role                public.officer_role not null,

  -- Free text such as "Financial Secretary". The role carries the permissions;
  -- the title is what the community calls the person.
  title               text,

  leadership_term_id  uuid references public.leadership_terms (id) on delete set null,

  -- ROLE-06 / SEC-10: for a collector, which collections and groups they may
  -- act within. NULL for every other role, which is checked below.
  scope               jsonb,

  started_at          timestamptz not null default now(),
  ended_at            timestamptz,
  start_reason        public.officer_term_start_reason not null default 'invited',
  end_reason          public.officer_term_end_reason,

  -- HND-04: the name the person held while serving. Kept here so a closed
  -- account (OWN-03) does not erase who ran the community in 2026.
  actor_name_snapshot text not null,

  created_by          uuid references public.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint officer_terms_title_length
    check (title is null or char_length(title) between 2 and 60),
  constraint officer_terms_dates_ordered
    check (ended_at is null or ended_at >= started_at),
  constraint officer_terms_ended_has_reason
    check ((ended_at is null) = (end_reason is null)),
  constraint officer_terms_scope_only_for_collectors
    check (scope is null or role = 'collector')
);

comment on table public.officer_terms is
  'OFF-02: the authority record. Time-bounded by design — ending a term removes rights without deleting anything (OFF-03, HND-04).';
comment on column public.officer_terms.actor_name_snapshot is
  'HND-04 / OWN-03: the name held while serving, so leadership history survives an account closure.';

-- ROLE-01: one officer role per community at a time. A person may hold roles in
-- many communities, and may have held several roles here over time — but only
-- one of them is open.
create unique index officer_terms_one_active_role_per_person
  on public.officer_terms (community_id, user_id)
  where ended_at is null;

create index officer_terms_active_idx
  on public.officer_terms (community_id, role)
  where ended_at is null;
create index officer_terms_user_active_idx
  on public.officer_terms (user_id)
  where ended_at is null;
create index officer_terms_history_idx
  on public.officer_terms (community_id, started_at desc);

create trigger officer_terms_set_updated_at
  before update on public.officer_terms
  for each row execute function app.set_updated_at();

alter table public.officer_terms enable row level security;
alter table public.officer_terms force row level security;


-- ── ROLE-02: a community can never drop below one active owner ───────────────
-- A CONSTRAINT trigger, deferred to the end of the transaction, because a
-- handover legitimately ends the outgoing owner's term and starts the incoming
-- one in the same statement. Checking per-row would reject the valid case;
-- checking at commit rejects only the case that actually leaves nobody in
-- charge.
create or replace function app.assert_community_has_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_community_id uuid := coalesce(new.community_id, old.community_id);
  v_owner_count  integer;
  v_status       public.community_status;
begin
  select status into v_status
  from public.communities
  where id = v_community_id;

  -- A community being deleted, or already archived, has no owner requirement.
  if v_status is null or v_status = 'archived' then
    return null;
  end if;

  select count(*) into v_owner_count
  from public.officer_terms
  where community_id = v_community_id
    and role = 'owner'
    and ended_at is null;

  if v_owner_count < 1 then
    raise exception
      'COMMUNITY_WOULD_HAVE_NO_OWNER: community % must keep at least one active owner (ROLE-02)',
      v_community_id
      using errcode = 'P0001',
            hint = 'Appoint a successor before ending the last owner term, or run an ownership recovery.';
  end if;

  return null;
end;
$$;

create constraint trigger officer_terms_assert_owner
  after update or delete on public.officer_terms
  deferrable initially deferred
  for each row execute function app.assert_community_has_owner();


-- ── has_permission ───────────────────────────────────────────────────────────
-- SEC-09. The single question every RLS policy and every server function asks.
--
-- SECURITY DEFINER because it reads officer_terms, which is itself protected by
-- RLS — without it, a policy that calls this would recurse. It is deliberately
-- narrow: it takes a community and a permission, returns a boolean, and cannot
-- be persuaded to return anything else. EXECUTE is granted to authenticated
-- only; `anon` has no business asking whether it holds a permission.
create or replace function app.has_permission(
  p_community_id uuid,
  p_permission   text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.officer_terms ot
    join public.role_permissions rp
      on rp.role = ot.role
     and rp.permission = p_permission
    where ot.community_id = p_community_id
      and ot.user_id      = auth.uid()
      and ot.ended_at is null
      and ot.started_at <= now()
  );
$$;

comment on function app.has_permission(uuid, text) is
  'SEC-09: does the caller hold this permission in this community, right now? Reads active officer terms only. Used by every RLS policy and re-checked in every server function (SEC-13, SEC-17).';

-- SEC-10, the collection-scoped counterpart of the function above, is NOT
-- defined here. It reads public.collections, which does not exist until
-- 20260917120700_collections.sql, and a `language sql` body is parsed and
-- resolved when the function is created — so defining it at this stage fails
-- the migration outright.
--
-- It lives in 20260917121000_rls_policies.sql, immediately before the policies
-- that call it. See that file for the definition and the reasoning.

-- The set of communities the caller currently holds any role in. Used by list
-- policies so a dashboard query is one index scan rather than a per-row
-- subquery.
create or replace function app.current_user_community_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select ot.community_id
  from public.officer_terms ot
  where ot.user_id = auth.uid()
    and ot.ended_at is null
    and ot.started_at <= now();
$$;

revoke all on function app.has_permission(uuid, text)   from public;
revoke all on function app.current_user_community_ids() from public;
-- The matching GRANTs are in 20260917121100_grants.sql, not here. That
-- migration revokes EXECUTE on every function in this schema from PUBLIC
-- retroactively, so a grant written here would simply be undone. One file
-- decides what a client role can reach.
