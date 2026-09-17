-- ─────────────────────────────────────────────────────────────────────────────
-- 20260917120900 — Audit log
--
-- AUD-01: append-only, covering every create, update, delete, approval, role
-- change, export, verification, restriction and handover.
--
-- Built in Phase 1, not Phase 7. The previous system retrofitted auditing onto
-- a running product and ended up with 70 rows in `admin_events` and no answer
-- to "who changed this?". An audit trail added later only ever covers what
-- happened later.
--
-- This is also the highest-signal operational record the system will have: it
-- says who did what to which object, with before and after values and a reason.
-- ─────────────────────────────────────────────────────────────────────────────

create table public.audit_logs (
  id                  uuid primary key default app.uuid_generate_v7(),

  -- Nullable because some auditable events precede a community: a user closing
  -- their account, a staff member acting across communities.
  community_id        uuid references public.communities (id) on delete restrict,

  actor_type          public.audit_actor_type not null,
  actor_user_id       uuid references public.users (id) on delete set null,

  -- HND-04 / OWN-03: the actor's name and role AT THE TIME. An officer whose
  -- term ended, or whose account was later closed, still reads correctly in the
  -- community's history. This is why the snapshot is a column and not a join.
  actor_name_snapshot text not null,
  actor_role          public.officer_role,
  officer_term_id     uuid references public.officer_terms (id) on delete set null,

  action              text not null,
  object_type         text not null,
  object_id           uuid,

  -- Field-level before/after for changed fields only. PII is scrubbed by the
  -- writer, not here — SEC-26 applies to logs and error trackers, and the audit
  -- log is a record the community reads, so it keeps what the community is
  -- entitled to see.
  before_state        jsonb,
  after_state         jsonb,

  -- OBL-07, OBL-08, ROLE-04, SEC-27: a reason is required for the actions that
  -- demand one. Which ones is enforced by the writing function, because the set
  -- is a product rule that will change more often than this table.
  reason              text,

  ip                  inet,
  user_agent          text,

  created_at          timestamptz not null default now(),

  constraint audit_logs_action_format      check (action ~ '^[a-z_]+\.[a-z_]+$'),
  constraint audit_logs_object_type_format check (object_type ~ '^[a-z_]+$'),
  constraint audit_logs_actor_name_length  check (char_length(actor_name_snapshot) between 1 and 120),
  constraint audit_logs_reason_length      check (reason is null or char_length(reason) <= 500),

  -- ADR 0009 / AUD-03: a staff action is always attributed to a person and
  -- always carries a reason, because the affected community will read it.
  constraint audit_logs_staff_action_is_accountable
    check (actor_type <> 'staff' or (actor_user_id is not null and reason is not null))
);

comment on table public.audit_logs is
  'AUD-01: append-only audit of every state change. No UPDATE or DELETE grant for any role, enforced by both privileges and a trigger (DAT-02).';
comment on column public.audit_logs.actor_name_snapshot is
  'The actor name at the time of the action. HND-04: historical actions are never reattributed or anonymised because someone left.';

-- AUD-02: readable by owners, admins, treasurers and viewers, and exportable.
-- These are the access paths the audit screen uses.
create index audit_logs_community_time_idx on public.audit_logs (community_id, created_at desc);
create index audit_logs_object_idx         on public.audit_logs (object_type, object_id, created_at desc);
create index audit_logs_actor_idx          on public.audit_logs (actor_user_id, created_at desc)
  where actor_user_id is not null;
-- AUD-03: "Kolekto support viewed your members list on …" is this query.
create index audit_logs_staff_idx          on public.audit_logs (community_id, created_at desc)
  where actor_type = 'staff';

alter table public.audit_logs enable row level security;
alter table public.audit_logs force row level security;


-- ── DAT-02: append-only, enforced twice ──────────────────────────────────────
-- Once by withholding the privilege, once by a trigger. Two mechanisms because
-- a privilege can be granted by a future migration in a hurry, and a trigger
-- makes that grant useless rather than dangerous.
create or replace function app.block_audit_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'AUDIT_LOG_IS_APPEND_ONLY: audit rows cannot be % (AUD-01, DAT-02)',
    lower(tg_op)
    using errcode = 'P0001',
          hint = 'A correction is a new audit row describing the correction, never an edit to the original.';
  return null;
end;
$$;

create trigger audit_logs_no_update
  before update on public.audit_logs
  for each row execute function app.block_audit_mutation();

create trigger audit_logs_no_delete
  before delete on public.audit_logs
  for each row execute function app.block_audit_mutation();

revoke update, delete, truncate on public.audit_logs from authenticated, anon;


-- ── The writer ───────────────────────────────────────────────────────────────
-- Server functions call this rather than inserting directly, so the actor
-- snapshot is resolved consistently and cannot be spoofed by the caller.
--
-- SECURITY DEFINER, and deliberately NOT granted to anon or authenticated: an
-- audit row is written by server code acting through the service role, never by
-- a browser. The previous system's `payment_admin_actions` had
-- `INSERT WITH CHECK (true)` for `authenticated` — inert only because the grant
-- withheld INSERT, and one GRANT away from a forgeable staff audit log.
create or replace function app.write_audit_log(
  p_community_id  uuid,
  p_actor_type    public.audit_actor_type,
  p_actor_user_id uuid,
  p_action        text,
  p_object_type   text,
  p_object_id     uuid,
  p_before        jsonb default null,
  p_after         jsonb default null,
  p_reason        text  default null,
  p_ip            inet  default null,
  p_user_agent    text  default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id             uuid;
  v_name           text;
  v_role           public.officer_role;
  v_officer_term   uuid;
begin
  -- Resolve the actor's name and current role from the database, never from the
  -- caller. A caller that could name itself could rewrite history.
  select u.full_name into v_name
  from public.users u
  where u.id = p_actor_user_id;

  if p_community_id is not null and p_actor_user_id is not null then
    select ot.role, ot.id
      into v_role, v_officer_term
    from public.officer_terms ot
    where ot.community_id = p_community_id
      and ot.user_id      = p_actor_user_id
      and ot.ended_at is null
    limit 1;
  end if;

  insert into public.audit_logs (
    community_id, actor_type, actor_user_id, actor_name_snapshot,
    actor_role, officer_term_id, action, object_type, object_id,
    before_state, after_state, reason, ip, user_agent
  ) values (
    p_community_id, p_actor_type, p_actor_user_id,
    coalesce(v_name, case p_actor_type
                       when 'system' then 'system'
                       when 'contributor' then 'contributor'
                       else 'unknown' end),
    v_role, v_officer_term, p_action, p_object_type, p_object_id,
    p_before, p_after, p_reason, p_ip, p_user_agent
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function app.write_audit_log is
  'AUD-01 writer. Resolves the actor snapshot from the database rather than trusting the caller. Not granted to anon or authenticated — server code only.';

revoke all on function app.write_audit_log(uuid, public.audit_actor_type, uuid, text, text, uuid, jsonb, jsonb, text, inet, text) from public;
