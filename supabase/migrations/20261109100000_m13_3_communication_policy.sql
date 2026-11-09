-- Promoted 2026-11-09 from docs/database/proposals/M13.3-COMMUNICATION-POLICY.proposed.sql (body unchanged; only this
-- status header replaced). Apply order: 20261109100000 policy -> 20261109100100 announcements -> 20261109100200 R3.
--
-- APPLY ORDER: this file FIRST, then MEMBER-ANNOUNCEMENTS.proposed.sql (which calls
-- app.community_communication_notice_attested and app.member_communication_opted_out defined here).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- M13.3 R2 — Community communication policy, notice attestation, member choices
--
-- docs/product/M13.3-COMMUNITY-NOTIFICATIONS-ARCHITECTURE-REVIEW.md (approved in
-- principle at R0, 2026-11-07) and docs/product/M13.3-R2-DATABASE-POLICY-PROPOSAL-REPORT.md.
-- The worker-side half is apps/worker/src/communication-policy.ts (R1).
--
-- Additive only:
--
--   1. app.communication_requirement(category, channel, payment_purpose)
--        The category × channel matrix, identical to the worker's
--        channelRequirement() with today's capabilities (payment attribution
--        and SMS both unapproved). The worker unit test
--        test/communication-policy-sql-parity.test.ts reads the VALUES list
--        below and fails if the two ever disagree.
--
--   2. Catalogue permission communication.attest_notice (owner, admin).
--
--   3. public.community_communication_attestations (append-only) and
--        app.attest_community_communication_notice(uuid, text)
--        app.revoke_community_communication_notice(uuid, text)
--        app.community_communication_notice_attested(uuid)   — worker reads it
--        app.community_communication_notice_status(uuid)     — officer UI
--      An attestation is an organiser's confirmation that members were told
--      how their contact details are used. It is NOT consent, NOT proof of a
--      lawful basis, and NEVER a substitute for a member's WhatsApp or
--      marketing permission (none of the functions below reads it for those).
--
--   4. public.member_communication_choices (append-only) and
--        app.member_communication_opted_out(uuid, text, text)
--        app.member_communication_permission(uuid, text)
--        app.record_member_communication_opt_out_on_request(...)  — organiser
--        app.record_own_communication_choice(...)                 — linked member
--        app.record_member_communication_choice(...)              — verified
--             accountless flow / channel STOP; executable by NO client role
--             until R4 decides its caller
--      Role rules are CHECK constraints, not just function logic: an officer
--      row can only be an opt-out or a permission withdrawal; only a member
--      can opt in or grant; a system row can only withdraw.
--
--   5. public.notification_deliveries.communication_category (nullable text,
--      CHECK on the four categories). Existing rows stay NULL: no category is
--      inferred for history. No backfill is executed.
--
--   6. Comment-only change on members.consent_messages_at: legacy, not a gate.
--
-- NOT changed: members (no column dropped, no value written or back-filled),
-- notification_preferences (still honoured as opt-outs by the eligibility
-- function, no writer added), transactional eligibility
-- (app.evaluate_email_eligibility), email_sending_enabled, send limits / bulk
-- caps, payment / obligation / ledger objects, worker-role grants.
--
-- Worker-role grants (operator step, NOT in this file):
--   grant execute on function app.community_communication_notice_attested(uuid) to <worker role>;
-- (itest: add to WORKER_ROLE_FUNCTIONS in scripts/itest/itest.mjs; production: the worker
-- deployment runbook.) The R1 worker feature-detects this function and treats its absence as
-- "not attested".
--
-- Rollback (all additive; run in reverse order, only after confirming nothing depends on the rows):
--   alter table public.notification_deliveries drop constraint notification_deliveries_communication_category_values;
--   alter table public.notification_deliveries drop column communication_category;
--   drop function app.record_member_communication_choice(uuid, text, text, text, text, text, text, uuid);
--   drop function app.record_own_communication_choice(uuid, text, text, text, text, text);
--   drop function app.record_member_communication_opt_out_on_request(uuid, text, text, text, text, text);
--   drop function app.member_communication_permission(uuid, text);
--   drop function app.member_communication_opted_out(uuid, text, text);
--   drop function app.insert_member_communication_choice(uuid, text, text, text, text, text, text, uuid, uuid, uuid, text, text, uuid);
--   drop table public.member_communication_choices;           -- evidence of opt-outs: export first (L8)
--   drop function app.community_communication_notice_status(uuid);
--   drop function app.community_communication_notice_attested(uuid);
--   drop function app.revoke_community_communication_notice(uuid, text);
--   drop function app.attest_community_communication_notice(uuid, text);
--   drop table public.community_communication_attestations;   -- export first
--   drop function app.block_communication_record_mutation();
--   drop function app.accepted_communication_notice_versions();
--   drop function app.communication_requirement(text, text, text);
--   delete from public.role_permissions where permission = 'communication.attest_notice';
--   delete from public.permissions where key = 'communication.attest_notice';
--   restore the members.consent_messages_at comment from 20260917120500.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. The policy matrix ─────────────────────────────────────────────────────
-- Requirement vocabulary (worker: Requirement['kind']):
--   always      no opt-out (essential content only)
--   default_on  sent unless opted out; detail 'community_notice' = also needs the attestation
--   opt_in      detail = the member-given permissions required, sorted, comma-separated
--   disabled    detail = the stable skip reason
create or replace function app.communication_requirement(
  p_category        text,
  p_channel         text,
  p_payment_purpose text default null
)
returns table (requirement text, detail text)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_purpose text;
begin
  if p_category is null or p_category not in ('essential', 'community_operational', 'marketing', 'payment') then
    raise exception 'INVALID_CATEGORY: %', p_category using errcode = '22023';
  end if;
  if p_channel is null or p_channel not in ('in_app', 'email', 'whatsapp', 'sms') then
    raise exception 'INVALID_CHANNEL: %', p_channel using errcode = '22023';
  end if;
  if p_payment_purpose is not null and p_payment_purpose not in ('status', 'targeted_reminder') then
    raise exception 'INVALID_PAYMENT_PURPOSE: %', p_payment_purpose using errcode = '22023';
  end if;
  -- A payment communication with no stated purpose is a targeted reminder,
  -- never essential (worker: same rule).
  v_purpose := case when p_category = 'payment' then coalesce(p_payment_purpose, 'targeted_reminder') else '' end;

  return query
  select m.requirement, m.detail
  from (values
    -- POLICY-MATRIX-BEGIN (parsed by apps/worker/test/communication-policy-sql-parity.test.ts; keep one row per line)
    ('essential',             '',                  'in_app',   'always',     null::text),
    ('essential',             '',                  'email',    'always',     null),
    ('essential',             '',                  'whatsapp', 'opt_in',     'whatsapp_permission'),
    ('essential',             '',                  'sms',      'disabled',   'channel_disabled'),
    ('community_operational', '',                  'in_app',   'always',     null),
    ('community_operational', '',                  'email',    'default_on', 'community_notice'),
    ('community_operational', '',                  'whatsapp', 'opt_in',     'whatsapp_permission'),
    ('community_operational', '',                  'sms',      'disabled',   'channel_disabled'),
    ('marketing',             '',                  'in_app',   'disabled',   'category_not_on_channel'),
    ('marketing',             '',                  'email',    'opt_in',     'marketing_consent'),
    ('marketing',             '',                  'whatsapp', 'opt_in',     'marketing_consent,whatsapp_permission'),
    ('marketing',             '',                  'sms',      'disabled',   'channel_disabled'),
    ('payment',               'status',            'in_app',   'disabled',   'payment_attribution_unavailable'),
    ('payment',               'status',            'email',    'disabled',   'payment_attribution_unavailable'),
    ('payment',               'status',            'whatsapp', 'disabled',   'payment_attribution_unavailable'),
    ('payment',               'status',            'sms',      'disabled',   'payment_attribution_unavailable'),
    ('payment',               'targeted_reminder', 'in_app',   'disabled',   'payment_attribution_unavailable'),
    ('payment',               'targeted_reminder', 'email',    'disabled',   'payment_attribution_unavailable'),
    ('payment',               'targeted_reminder', 'whatsapp', 'disabled',   'payment_attribution_unavailable'),
    ('payment',               'targeted_reminder', 'sms',      'disabled',   'payment_attribution_unavailable')
    -- POLICY-MATRIX-END
  ) as m (category, purpose, channel, requirement, detail)
  where m.category = p_category
    and m.purpose  = v_purpose
    and m.channel  = p_channel;
end;
$$;

comment on function app.communication_requirement(text, text, text) is
  'M13.3 R2: the communication policy matrix (category × channel → always / default_on / opt_in / disabled), identical to apps/worker/src/communication-policy.ts with today''s capabilities (no payment attribution, SMS not approved). Changing a row is a reviewed product decision; the worker parity test fails if the two disagree.';

revoke all on function app.communication_requirement(text, text, text) from public;
revoke execute on function app.communication_requirement(text, text, text) from public, anon, authenticated;


-- ── 2. Permission: who may attest ────────────────────────────────────────────
-- Same mechanism as notification.view_delivery_log (20261009100100): a
-- catalogue row plus explicit role rows. Owner is inserted explicitly because
-- the owner row set was produced by a one-time insert … select.
insert into public.permissions (key, description) values
  ('communication.attest_notice',
   'Confirm that members have been told how their contact details are used for community communications');

insert into public.role_permissions (role, permission) values
  ('owner', 'communication.attest_notice'),
  ('admin', 'communication.attest_notice');


-- ── 3. Community notice attestation ──────────────────────────────────────────

-- The notice wording versions an attestation may name. A new wording is a new
-- version; communities must attest again before it counts (supersede). The
-- wording of community-notice-v1 itself is a product/legal decision (R2 report).
create or replace function app.accepted_communication_notice_versions()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['community-notice-v1']::text[];
$$;

comment on function app.accepted_communication_notice_versions() is
  'M13.3 R2: notice wording versions an attestation may name. An attestation of a version not listed here does not count.';

revoke all on function app.accepted_communication_notice_versions() from public;
revoke execute on function app.accepted_communication_notice_versions() from public, anon, authenticated;

-- One generic append-only guard for the two evidence tables below.
create or replace function app.block_communication_record_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'COMMUNICATION_RECORD_IS_APPEND_ONLY: % rows cannot be % (M13.3)', tg_table_name, lower(tg_op)
    using errcode = 'P0001',
          hint = 'Record a new row (a revocation, an opt-in, a withdrawal) instead of changing history.';
  return null;
end;
$$;

revoke all on function app.block_communication_record_mutation() from public;
revoke execute on function app.block_communication_record_mutation() from public, anon, authenticated;

create table public.community_communication_attestations (
  id              uuid primary key default app.uuid_generate_v7(),
  -- Total order within a community, independent of clock resolution.
  seq             bigint generated always as identity,
  community_id    uuid not null references public.communities (id) on delete restrict,
  action          text not null,
  notice_version  text,
  revoke_reason   text,
  recorded_by     uuid not null references public.users (id) on delete restrict,
  officer_term_id uuid not null references public.officer_terms (id) on delete restrict,
  officer_role    public.officer_role not null,
  audit_log_id    uuid not null references public.audit_logs (id) on delete restrict,
  recorded_at     timestamptz not null default now(),

  constraint community_communication_attestations_action_values
    check (action in ('attest', 'revoke')),
  constraint community_communication_attestations_version_format
    check (notice_version is null or notice_version ~ '^[a-z0-9][a-z0-9._-]{1,39}$'),
  constraint community_communication_attestations_attest_has_version
    check ((action = 'attest') = (notice_version is not null)),
  constraint community_communication_attestations_revoke_has_reason
    check ((action = 'revoke') = (revoke_reason is not null)),
  constraint community_communication_attestations_reason_values
    check (revoke_reason is null
           or revoke_reason in ('notice_changed', 'attested_in_error', 'community_request', 'other'))
);

comment on table public.community_communication_attestations is
  'M13.3 R2: append-only history of community communication notice attestations and revocations. The latest row per community decides. An attestation records that an authorised officer CONFIRMED members were informed; it is not consent, not proof of a lawful basis, and not a WhatsApp or marketing permission. No client role can read or write the table; use the app.* functions.';

create unique index community_communication_attestations_seq_key
  on public.community_communication_attestations (seq);
create index community_communication_attestations_latest_idx
  on public.community_communication_attestations (community_id, seq desc);

alter table public.community_communication_attestations enable row level security;
alter table public.community_communication_attestations force row level security;
revoke all on table public.community_communication_attestations from public, anon, authenticated;

create trigger community_communication_attestations_no_update
  before update on public.community_communication_attestations
  for each row execute function app.block_communication_record_mutation();
create trigger community_communication_attestations_no_delete
  before delete on public.community_communication_attestations
  for each row execute function app.block_communication_record_mutation();
create trigger community_communication_attestations_no_truncate
  before truncate on public.community_communication_attestations
  for each statement execute function app.block_communication_record_mutation();

-- 3a. The restrictive read the worker and the eligibility function use.
create or replace function app.community_communication_notice_attested(p_community_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
           select a.action = 'attest'
                  and a.notice_version = any (app.accepted_communication_notice_versions())
           from public.community_communication_attestations a
           where a.community_id = p_community_id
           order by a.seq desc
           limit 1
         ), false)
     and exists (
           select 1 from public.communities c
           where c.id = p_community_id and c.status = 'active'
         );
$$;

comment on function app.community_communication_notice_attested(uuid) is
  'M13.3 R2: true only when the community is active and its latest attestation row is an attestation (not a revocation) of an accepted notice version. False for no row, a revocation, an unaccepted version, an unknown or inactive community. Worker + internal only; not consent and not a channel permission.';

revoke all on function app.community_communication_notice_attested(uuid) from public;
revoke execute on function app.community_communication_notice_attested(uuid) from public, anon, authenticated;

-- 3b. Attest (or supersede with a newer version).
create or replace function app.attest_community_communication_notice(
  p_community_id   uuid,
  p_notice_version text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := auth.uid();
  v_term     record;
  v_latest   record;
  v_audit_id uuid;
  v_id       uuid;
begin
  if v_actor is null then
    raise exception 'FORBIDDEN: an attestation must be made by a signed-in officer' using errcode = '42501';
  end if;
  perform app.require_permission(p_community_id, 'communication.attest_notice');

  if p_notice_version is null or not (p_notice_version = any (app.accepted_communication_notice_versions())) then
    raise exception 'INVALID_NOTICE_VERSION: % is not an accepted notice version', p_notice_version
      using errcode = '22023';
  end if;

  if not exists (select 1 from public.communities c where c.id = p_community_id and c.status = 'active') then
    raise exception 'INVALID_STATE: only an active community can attest' using errcode = 'P0001';
  end if;

  select ot.id, ot.role into v_term
  from public.officer_terms ot
  where ot.community_id = p_community_id and ot.user_id = v_actor
    and ot.ended_at is null and ot.started_at <= now()
  order by ot.started_at desc
  limit 1;
  if v_term.id is null then
    raise exception 'FORBIDDEN: no active officer term' using errcode = '42501';
  end if;

  -- Serialise attest/revoke per community so "latest" is well defined.
  perform pg_advisory_xact_lock(hashtextextended('community_communication_attestation:' || p_community_id::text, 0));

  select a.id, a.action, a.notice_version into v_latest
  from public.community_communication_attestations a
  where a.community_id = p_community_id
  order by a.seq desc
  limit 1;

  -- Idempotent: attesting the version already in force writes nothing.
  if v_latest.id is not null and v_latest.action = 'attest' and v_latest.notice_version = p_notice_version then
    return v_latest.id;
  end if;

  v_audit_id := app.write_audit_log(
    p_community_id, 'officer', v_actor,
    'community.communication_notice_attest', 'community', p_community_id,
    case when v_latest.id is null then null
         else jsonb_build_object('action', v_latest.action, 'notice_version', v_latest.notice_version) end,
    jsonb_build_object('notice_version', p_notice_version),
    null
  );

  insert into public.community_communication_attestations
    (community_id, action, notice_version, recorded_by, officer_term_id, officer_role, audit_log_id)
  values
    (p_community_id, 'attest', p_notice_version, v_actor, v_term.id, v_term.role, v_audit_id)
  returning id into v_id;

  return v_id;
end;
$$;

comment on function app.attest_community_communication_notice(uuid, text) is
  'M13.3 R2: an officer with communication.attest_notice (owner, admin) confirms that members were informed under the named notice version. Audited (community.communication_notice_attest), records the officer, term, role and time. Re-attesting the version in force is a no-op; a newer accepted version supersedes. Not consent.';

revoke all on function app.attest_community_communication_notice(uuid, text) from public;
revoke execute on function app.attest_community_communication_notice(uuid, text) from public, anon;
grant  execute on function app.attest_community_communication_notice(uuid, text) to authenticated;

-- 3c. Revoke. After this, no community operational email is pending-eligible.
create or replace function app.revoke_community_communication_notice(
  p_community_id uuid,
  p_reason       text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := auth.uid();
  v_term     record;
  v_latest   record;
  v_audit_id uuid;
  v_id       uuid;
begin
  if v_actor is null then
    raise exception 'FORBIDDEN: a revocation must be made by a signed-in officer' using errcode = '42501';
  end if;
  perform app.require_permission(p_community_id, 'communication.attest_notice');

  if p_reason is null or p_reason not in ('notice_changed', 'attested_in_error', 'community_request', 'other') then
    raise exception 'INVALID_REASON: %', p_reason using errcode = '22023';
  end if;

  select ot.id, ot.role into v_term
  from public.officer_terms ot
  where ot.community_id = p_community_id and ot.user_id = v_actor
    and ot.ended_at is null and ot.started_at <= now()
  order by ot.started_at desc
  limit 1;
  if v_term.id is null then
    raise exception 'FORBIDDEN: no active officer term' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('community_communication_attestation:' || p_community_id::text, 0));

  select a.id, a.action, a.notice_version into v_latest
  from public.community_communication_attestations a
  where a.community_id = p_community_id
  order by a.seq desc
  limit 1;

  -- Nothing in force: nothing to revoke, nothing written.
  if v_latest.id is null or v_latest.action = 'revoke' then
    return null;
  end if;

  v_audit_id := app.write_audit_log(
    p_community_id, 'officer', v_actor,
    'community.communication_notice_revoke', 'community', p_community_id,
    jsonb_build_object('action', 'attest', 'notice_version', v_latest.notice_version),
    jsonb_build_object('action', 'revoke', 'revoke_reason', p_reason),
    null
  );

  insert into public.community_communication_attestations
    (community_id, action, revoke_reason, recorded_by, officer_term_id, officer_role, audit_log_id)
  values
    (p_community_id, 'revoke', p_reason, v_actor, v_term.id, v_term.role, v_audit_id)
  returning id into v_id;

  return v_id;
end;
$$;

comment on function app.revoke_community_communication_notice(uuid, text) is
  'M13.3 R2: an officer with communication.attest_notice revokes the attestation in force (reason from a fixed list). Audited. Returns null and writes nothing when no attestation is in force.';

revoke all on function app.revoke_community_communication_notice(uuid, text) from public;
revoke execute on function app.revoke_community_communication_notice(uuid, text) from public, anon;
grant  execute on function app.revoke_community_communication_notice(uuid, text) to authenticated;

-- 3d. Status for the organiser UI (no table access needed).
create or replace function app.community_communication_notice_status(p_community_id uuid)
returns table (
  attested               boolean,
  notice_version         text,
  recorded_at            timestamptz,
  recorded_by_name       text,
  latest_action          text,
  accepted_versions      text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (app.has_permission(p_community_id, 'communication.attest_notice')
          or app.has_permission(p_community_id, 'collection.publish')) then
    raise exception 'FORBIDDEN: missing permission in community %', p_community_id using errcode = '42501';
  end if;

  return query
  select
    app.community_communication_notice_attested(p_community_id),
    l.notice_version,
    l.recorded_at,
    l.actor_name,
    l.action,
    app.accepted_communication_notice_versions()
  from (select 1) as one
  left join lateral (
    select a.notice_version, a.recorded_at, a.action, al.actor_name_snapshot as actor_name
    from public.community_communication_attestations a
    join public.audit_logs al on al.id = a.audit_log_id
    where a.community_id = p_community_id
    order by a.seq desc
    limit 1
  ) l on true;
end;
$$;

comment on function app.community_communication_notice_status(uuid) is
  'M13.3 R2: the community''s current attestation state for officers with communication.attest_notice or collection.publish: attested flag, latest row (version, time, officer name snapshot, action) and the accepted versions. Reads only.';

revoke all on function app.community_communication_notice_status(uuid) from public;
revoke execute on function app.community_communication_notice_status(uuid) from public, anon;
grant  execute on function app.community_communication_notice_status(uuid) to authenticated;


-- ── 4. Member communication choices ──────────────────────────────────────────
-- member_id and delivery_id carry no foreign key on purpose: a member row may
-- be hard-deleted (a rejected join), and an append-only evidence table cannot
-- take the UPDATE / DELETE an ON DELETE action would issue. Tenancy is checked
-- by the only writer (app.insert_member_communication_choice). The rows hold
-- ids and codes only — no address, name or free text.
create table public.member_communication_choices (
  id                  uuid primary key default app.uuid_generate_v7(),
  seq                 bigint generated always as identity,
  community_id        uuid not null references public.communities (id) on delete restrict,
  member_id           uuid not null,
  category            text not null,
  channel             text not null,
  choice              text not null,
  permission          text,
  source              text not null,
  actor_type          text not null,
  recorded_by_user_id uuid references public.users (id) on delete restrict,
  officer_term_id     uuid references public.officer_terms (id) on delete restrict,
  request_channel     text,
  wording_version     text,
  delivery_id         uuid,
  audit_log_id        uuid references public.audit_logs (id) on delete restrict,
  recorded_at         timestamptz not null default now(),

  -- Vocabulary. Essential (A) is not optional, so it is not a choice category.
  constraint member_communication_choices_category_values
    check (category in ('community_operational', 'payment', 'marketing')),
  -- in_app is not configurable; 'all' = every external channel.
  constraint member_communication_choices_channel_values
    check (channel in ('email', 'whatsapp', 'sms', 'all')),
  constraint member_communication_choices_choice_values
    check (choice in ('opt_out', 'opt_in', 'grant_permission', 'withdraw_permission')),
  constraint member_communication_choices_permission_values
    check (permission is null or permission in ('whatsapp_permission', 'marketing_consent')),
  constraint member_communication_choices_source_values
    check (source in ('member_verified_link', 'member_account', 'organiser_on_member_request', 'channel_stop_reply')),
  constraint member_communication_choices_actor_values
    check (actor_type in ('member', 'officer', 'system')),
  constraint member_communication_choices_request_channel_values
    check (request_channel is null or request_channel in ('in_person', 'phone', 'email', 'message', 'other')),
  constraint member_communication_choices_wording_format
    check (wording_version is null or wording_version ~ '^[a-z0-9][a-z0-9._-]{1,39}$'),

  -- Shape.
  constraint member_communication_choices_permission_iff_permission_choice
    check ((choice in ('grant_permission', 'withdraw_permission')) = (permission is not null)),
  constraint member_communication_choices_whatsapp_permission_on_whatsapp
    check (permission is distinct from 'whatsapp_permission' or channel = 'whatsapp'),
  constraint member_communication_choices_marketing_consent_on_marketing
    check (permission is distinct from 'marketing_consent' or category = 'marketing'),
  constraint member_communication_choices_all_channel_is_opt_choice
    check (channel <> 'all' or choice in ('opt_out', 'opt_in')),
  -- Marketing and WhatsApp are permission-based: "opt back in" there is a grant.
  constraint member_communication_choices_opt_in_not_permission_based
    check (choice <> 'opt_in' or (category <> 'marketing' and channel <> 'whatsapp')),
  constraint member_communication_choices_grant_has_wording
    check (choice <> 'grant_permission' or wording_version is not null),

  -- Role rules (R0 decision 4), enforced by the table itself.
  constraint member_communication_choices_only_member_opts_in_or_grants
    check (choice not in ('opt_in', 'grant_permission') or actor_type = 'member'),
  constraint member_communication_choices_officer_rows
    check (actor_type <> 'officer'
           or (choice in ('opt_out', 'withdraw_permission')
               and source = 'organiser_on_member_request'
               and recorded_by_user_id is not null
               and officer_term_id is not null
               and request_channel is not null)),
  constraint member_communication_choices_organiser_source_is_officer
    check (source <> 'organiser_on_member_request' or actor_type = 'officer'),
  constraint member_communication_choices_member_sources
    check (source not in ('member_verified_link', 'member_account') or actor_type = 'member'),
  constraint member_communication_choices_account_source_has_user
    check (source <> 'member_account' or recorded_by_user_id is not null),
  constraint member_communication_choices_system_rows
    check (actor_type <> 'system'
           or (source = 'channel_stop_reply' and choice in ('opt_out', 'withdraw_permission'))),
  constraint member_communication_choices_stop_reply_is_system
    check (source <> 'channel_stop_reply' or actor_type = 'system')
);

comment on table public.member_communication_choices is
  'M13.3 R2: append-only history of members'' communication choices per community × category × channel: opt-outs, opt-ins after an opt-out, and member-given permissions (WhatsApp, marketing). The latest relevant row decides. CHECK constraints enforce that an officer row can only be an opt-out or a withdrawal recorded on the member''s request, and only a member can opt in or grant. No client role can read or write the table.';

create unique index member_communication_choices_seq_key on public.member_communication_choices (seq);
create index member_communication_choices_member_idx
  on public.member_communication_choices (member_id, category, channel, seq desc);
create index member_communication_choices_permission_idx
  on public.member_communication_choices (member_id, permission, seq desc)
  where permission is not null;

alter table public.member_communication_choices enable row level security;
alter table public.member_communication_choices force row level security;
revoke all on table public.member_communication_choices from public, anon, authenticated;

create trigger member_communication_choices_no_update
  before update on public.member_communication_choices
  for each row execute function app.block_communication_record_mutation();
create trigger member_communication_choices_no_delete
  before delete on public.member_communication_choices
  for each row execute function app.block_communication_record_mutation();
create trigger member_communication_choices_no_truncate
  before truncate on public.member_communication_choices
  for each statement execute function app.block_communication_record_mutation();

-- 4a. Current state: opted out of this category on this channel?
-- The latest opt_out / opt_in row for (member, category) on this channel or
-- on 'all' decides. No row = not opted out (community operational is
-- default-on under the policy; permission-based channels are checked
-- separately by app.member_communication_permission).
create or replace function app.member_communication_opted_out(
  p_member_id uuid,
  p_category  text,
  p_channel   text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select c.choice = 'opt_out'
    from public.member_communication_choices c
    where c.member_id = p_member_id
      and c.category  = p_category
      and c.channel in (p_channel, 'all')
      and c.choice in ('opt_out', 'opt_in')
    order by c.seq desc
    limit 1
  ), false);
$$;

comment on function app.member_communication_opted_out(uuid, text, text) is
  'M13.3 R2: whether the member''s latest opt-out/opt-in for this category on this channel (or on all channels) is an opt-out. Internal; read by the eligibility functions.';

revoke all on function app.member_communication_opted_out(uuid, text, text) from public;
revoke execute on function app.member_communication_opted_out(uuid, text, text) from public, anon, authenticated;

-- 4b. Current state: does a member-given permission stand?
create or replace function app.member_communication_permission(
  p_member_id  uuid,
  p_permission text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select c.choice = 'grant_permission'
    from public.member_communication_choices c
    where c.member_id  = p_member_id
      and c.permission = p_permission
    order by c.seq desc
    limit 1
  ), false);
$$;

comment on function app.member_communication_permission(uuid, text) is
  'M13.3 R2: whether the member''s latest grant/withdrawal of this permission is a grant. Never true without a member-recorded grant; an attestation or membership never makes it true. Internal.';

revoke all on function app.member_communication_permission(uuid, text) from public;
revoke execute on function app.member_communication_permission(uuid, text) from public, anon, authenticated;

-- 4c. The single writer. Validates tenancy and vocabulary, audits, inserts.
-- Internal: every client-facing path below calls it after its own identity
-- check. The table CHECKs are the last line for the role rules.
create or replace function app.insert_member_communication_choice(
  p_member_id         uuid,
  p_category          text,
  p_channel           text,
  p_choice            text,
  p_permission        text,
  p_source            text,
  p_actor_type        text,
  p_recorded_by       uuid,
  p_officer_term_id   uuid,
  p_delivery_id       uuid,
  p_request_channel   text,
  p_wording_version   text,
  p_expected_community uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member   record;
  v_audit_id uuid;
  v_id       uuid;
begin
  select m.id, m.community_id, m.status into v_member
  from public.members m
  where m.id = p_member_id;

  if v_member.id is null then
    raise exception 'NOT_FOUND: member % does not exist', p_member_id using errcode = 'P0002';
  end if;
  if p_expected_community is not null and v_member.community_id <> p_expected_community then
    raise exception 'FORBIDDEN: member is not in this community' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('member_communication_choice:' || p_member_id::text, 0));

  v_audit_id := app.write_audit_log(
    v_member.community_id,
    p_actor_type::public.audit_actor_type,
    p_recorded_by,
    'member.communication_choice',
    'member',
    p_member_id,
    null,
    jsonb_build_object(
      'category', p_category, 'channel', p_channel, 'choice', p_choice,
      'permission', p_permission, 'source', p_source
    ),
    null
  );

  insert into public.member_communication_choices (
    community_id, member_id, category, channel, choice, permission, source, actor_type,
    recorded_by_user_id, officer_term_id, request_channel, wording_version, delivery_id, audit_log_id
  ) values (
    v_member.community_id, p_member_id, p_category, p_channel, p_choice, p_permission, p_source, p_actor_type,
    p_recorded_by, p_officer_term_id, p_request_channel, p_wording_version, p_delivery_id, v_audit_id
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function app.insert_member_communication_choice(uuid, text, text, text, text, text, text, uuid, uuid, uuid, text, text, uuid) is
  'M13.3 R2 (internal): the only writer of member_communication_choices. Audits member.communication_choice (codes only). Callers perform the identity check.';

revoke all on function app.insert_member_communication_choice(uuid, text, text, text, text, text, text, uuid, uuid, uuid, text, text, uuid) from public;
revoke execute on function app.insert_member_communication_choice(uuid, text, text, text, text, text, text, uuid, uuid, uuid, text, text, uuid) from public, anon, authenticated;

-- 4d. Organiser: record an opt-out (or a permission withdrawal) the member asked for.
-- There is no parameter that could make this an opt-in or a grant.
create or replace function app.record_member_communication_opt_out_on_request(
  p_member_id       uuid,
  p_category        text,
  p_channel         text,
  p_request_channel text,
  p_choice          text default 'opt_out',
  p_permission      text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor        uuid := auth.uid();
  v_community_id uuid;
  v_term         uuid;
  v_already      boolean;
begin
  if v_actor is null then
    raise exception 'FORBIDDEN: must be a signed-in officer' using errcode = '42501';
  end if;
  if p_choice is null or p_choice not in ('opt_out', 'withdraw_permission') then
    raise exception 'FORBIDDEN_CHOICE: an organiser may only record an opt-out or a withdrawal'
      using errcode = '42501';
  end if;
  if (p_choice = 'withdraw_permission') <> (p_permission is not null) then
    raise exception 'INVALID_REQUEST: a withdrawal names exactly one permission; an opt-out names none'
      using errcode = '22023';
  end if;

  select m.community_id into v_community_id from public.members m where m.id = p_member_id;
  if v_community_id is null then
    raise exception 'NOT_FOUND: member % does not exist', p_member_id using errcode = 'P0002';
  end if;
  perform app.require_permission(v_community_id, 'member.edit');
  -- R2-verify fix: app.has_permission ignores role_permissions.scoped, so a
  -- collector (member.edit is SCOPED for collectors) would otherwise reach
  -- every member of the community. Apply the same scope rule as reading the
  -- roll (app.can_view_member, 20261019130000): unscoped roles see the whole
  -- community; a collector with a collection scope only members with an
  -- obligation in that scope.
  if not app.can_view_member(p_member_id, v_community_id) then
    raise exception 'FORBIDDEN: member is outside your scope' using errcode = '42501';
  end if;

  select ot.id into v_term
  from public.officer_terms ot
  where ot.community_id = v_community_id and ot.user_id = v_actor
    and ot.ended_at is null and ot.started_at <= now()
  order by ot.started_at desc
  limit 1;

  -- No-op when the member is already in that state (no duplicate evidence).
  v_already := case
    when p_choice = 'opt_out' then app.member_communication_opted_out(p_member_id, p_category, p_channel)
    else not app.member_communication_permission(p_member_id, p_permission)
  end;
  if v_already then
    return null;
  end if;

  return app.insert_member_communication_choice(
    p_member_id, p_category, p_channel, p_choice, p_permission,
    'organiser_on_member_request', 'officer', v_actor, v_term,
    null, p_request_channel, null, v_community_id
  );
end;
$$;

comment on function app.record_member_communication_opt_out_on_request(uuid, text, text, text, text, text) is
  'M13.3 R2: an officer with member.edit, and with the member inside their scope (app.can_view_member — a scoped collector only reaches members with an obligation in its collections), records an opt-out (or a permission withdrawal) that the member requested, with how they asked (in_person/phone/email/message/other). Can never opt in, grant, or reverse a member''s opt-out. No-op if already in that state.';

revoke all on function app.record_member_communication_opt_out_on_request(uuid, text, text, text, text, text) from public;
revoke execute on function app.record_member_communication_opt_out_on_request(uuid, text, text, text, text, text) from public, anon;
grant  execute on function app.record_member_communication_opt_out_on_request(uuid, text, text, text, text, text) to authenticated;

-- 4e. A member with a linked account records their own choice.
-- This is ONE of two member paths; members never need an account (4f).
create or replace function app.record_own_communication_choice(
  p_member_id       uuid,
  p_category        text,
  p_channel         text,
  p_choice          text,
  p_permission      text default null,
  p_wording_version text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null
     or not exists (select 1 from public.members m where m.id = p_member_id and m.user_id = v_actor) then
    raise exception 'FORBIDDEN: only the member themselves may record this choice' using errcode = '42501';
  end if;

  return app.insert_member_communication_choice(
    p_member_id, p_category, p_channel, p_choice, p_permission,
    'member_account', 'member', v_actor, null,
    null, null, p_wording_version, null
  );
end;
$$;

comment on function app.record_own_communication_choice(uuid, text, text, text, text, text) is
  'M13.3 R2: a member whose record is linked to the caller''s account (members.user_id = auth.uid()) records their own opt-out, opt-in, grant or withdrawal. Not required: accountless members use the verified-link path.';

revoke all on function app.record_own_communication_choice(uuid, text, text, text, text, text) from public;
revoke execute on function app.record_own_communication_choice(uuid, text, text, text, text, text) from public, anon;
grant  execute on function app.record_own_communication_choice(uuid, text, text, text, text, text) to authenticated;

-- 4f. Accountless member (verified link) or a channel STOP reply.
-- Executable by NO client role. The caller is the server-side verifier of a
-- signed per-delivery token (R4) or the channel adapter's STOP handler; that
-- caller, its role and its grant are decided in R4. Until then nothing can
-- reach it except the database owner — restrictive by default.
create or replace function app.record_member_communication_choice(
  p_member_id       uuid,
  p_category        text,
  p_channel         text,
  p_choice          text,
  p_permission      text,
  p_source          text,
  p_wording_version text,
  p_delivery_id     uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_type text;
  v_recipient  uuid;
begin
  if p_source = 'member_verified_link' then
    v_actor_type := 'member';
  elsif p_source = 'channel_stop_reply' then
    v_actor_type := 'system';
  else
    raise exception 'INVALID_SOURCE: % (use member_verified_link or channel_stop_reply)', p_source
      using errcode = '22023';
  end if;

  -- A link-sourced choice must come from a delivery that was addressed to this member.
  if p_delivery_id is not null then
    select d.recipient_member_id into v_recipient
    from public.notification_deliveries d where d.id = p_delivery_id;
    if v_recipient is distinct from p_member_id then
      raise exception 'FORBIDDEN: the delivery was not addressed to this member' using errcode = '42501';
    end if;
  elsif p_source = 'member_verified_link' then
    raise exception 'INVALID_REQUEST: a verified-link choice must name its delivery' using errcode = '22023';
  end if;

  return app.insert_member_communication_choice(
    p_member_id, p_category, p_channel, p_choice, p_permission,
    p_source, v_actor_type, null, null,
    p_delivery_id, null, p_wording_version, null
  );
end;
$$;

comment on function app.record_member_communication_choice(uuid, text, text, text, text, text, text, uuid) is
  'M13.3 R2: accountless member choice through a verified per-delivery link (member_verified_link, any choice) or a channel STOP reply (channel_stop_reply, opt-out/withdrawal only — enforced by CHECK). No client role may execute it; the verified caller is decided in R4.';

revoke all on function app.record_member_communication_choice(uuid, text, text, text, text, text, text, uuid) from public;
revoke execute on function app.record_member_communication_choice(uuid, text, text, text, text, text, text, uuid) from public, anon, authenticated;


-- ── 5. Delivery category ─────────────────────────────────────────────────────
-- Nullable; existing rows stay NULL. No category is inferred for history.
-- A later backfill, if ever wanted, could only be derived from
-- notification_events.event_type through the policy map, and would need its
-- own approval (R2 report §backfill). None is executed here.
alter table public.notification_deliveries
  add column communication_category text;

alter table public.notification_deliveries
  add constraint notification_deliveries_communication_category_values
    check (communication_category is null
           or communication_category in ('essential', 'community_operational', 'marketing', 'payment'));

comment on column public.notification_deliveries.communication_category is
  'M13.3 R2: the communication category the worker decided under (apps/worker/src/communication-policy.ts). NULL for rows written before M13.3 — never inferred.';


-- ── 6. Legacy consent column ─────────────────────────────────────────────────
comment on column public.members.consent_messages_at is
  'LEGACY (M13.3, 2026-11-07). Not read by any eligibility decision and not a gate for community operational, essential or payment communications. Never written or back-filled. Member permissions (WhatsApp, marketing) and opt-outs live in member_communication_choices. Kept so no data or history is lost.';
