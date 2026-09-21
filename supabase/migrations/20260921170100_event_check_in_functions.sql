-- ─────────────────────────────────────────────────────────────────────────────
-- 20260921170100 — Admitting and releasing, server-side
--
-- Same contract as every other write in this schema (ADR 0008): SECURITY
-- DEFINER, re-check the permission, derive tenancy from the row rather than
-- from the caller's claim about it, write an audit entry.
--
-- Both operations are idempotent in the way a door needs:
--   · checking in somebody already inside returns their existing visit
--     rather than raising — a second tap on a phone at a busy entrance must
--     not produce an error the operator has to read
--   · checking out somebody already outside does the same
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.check_in_obligation(p_obligation_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_obligation public.obligations%rowtype;
  v_existing   uuid;
  v_id         uuid;
begin
  select * into v_obligation from public.obligations where id = p_obligation_id;
  if v_obligation.id is null then
    raise exception 'NOT_FOUND: that ticket does not exist' using errcode = 'P0002';
  end if;

  -- The community comes from the obligation, never from the caller. A caller
  -- who names another community's obligation is refused by the permission
  -- check that follows, not by trusting what they said (SEC-18).
  perform app.require_permission(v_obligation.community_id, 'attendance.check_in');

  if v_obligation.exempt then
    raise exception 'NOT_ADMITTED: this person was exempted from this collection' using errcode = 'P0001';
  end if;

  select id into v_existing
  from public.event_check_ins
  where obligation_id = p_obligation_id and checked_out_at is null;

  -- Already inside: the same visit, not a second one.
  if v_existing is not null then
    return v_existing;
  end if;

  v_id := app.uuid_generate_v7();
  insert into public.event_check_ins (id, community_id, collection_id, obligation_id, checked_in_by)
  values (v_id, v_obligation.community_id, v_obligation.collection_id, p_obligation_id, auth.uid());

  perform app.write_audit_log(
    v_obligation.community_id, 'officer', auth.uid(), 'attendance.check_in', 'obligation', p_obligation_id,
    null, jsonb_build_object('collection_id', v_obligation.collection_id)
  );

  return v_id;
end;
$$;

comment on function app.check_in_obligation(uuid) is
  'M7.5: admits the member an obligation belongs to. Idempotent — admitting somebody already inside returns their open visit. Carries no money and records none.';


create or replace function app.check_out_obligation(p_obligation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_obligation public.obligations%rowtype;
  v_existing   uuid;
begin
  select * into v_obligation from public.obligations where id = p_obligation_id;
  if v_obligation.id is null then
    raise exception 'NOT_FOUND: that ticket does not exist' using errcode = 'P0002';
  end if;

  perform app.require_permission(v_obligation.community_id, 'attendance.check_in');

  select id into v_existing
  from public.event_check_ins
  where obligation_id = p_obligation_id and checked_out_at is null;

  -- Already outside: nothing to do, and nothing to complain about.
  if v_existing is null then
    return;
  end if;

  update public.event_check_ins
  set checked_out_at = now(), checked_out_by = auth.uid()
  where id = v_existing;

  perform app.write_audit_log(
    v_obligation.community_id, 'officer', auth.uid(), 'attendance.check_out', 'obligation', p_obligation_id,
    null, jsonb_build_object('collection_id', v_obligation.collection_id)
  );
end;
$$;

comment on function app.check_out_obligation(uuid) is
  'M7.5: records that somebody admitted earlier has left. Idempotent — checking out somebody already outside does nothing.';

revoke execute on function app.check_in_obligation(uuid)  from public;
revoke execute on function app.check_out_obligation(uuid) from public;
grant  execute on function app.check_in_obligation(uuid)  to authenticated;
grant  execute on function app.check_out_obligation(uuid) to authenticated;

grant select on public.event_check_ins to authenticated;
