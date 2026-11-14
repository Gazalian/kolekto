-- ─────────────────────────────────────────────────────────────────────────────
-- 20261012100000 — Centralized email recipient eligibility (M13.2 P4)
--
-- Decision record §6, §7; membership inventory F-1 (no account linking in M13.2).
--
-- What this does, and only this:
--
--   1. Adds app.email_address_usable(text): a conservative single-mailbox
--      plausibility check (length, shape, no whitespace/control characters).
--      It mirrors the delivery-table guard
--      (notification_deliveries_email_has_valid_address, 20261009100100) so an
--      address the worker stores can never fail that constraint. Plausibility,
--      not proof that the mailbox exists.
--   2. Adds app.evaluate_email_eligibility(p_event_type, p_object_id,
--      p_asserted_user_id): the SINGLE place that decides whether an event may
--      be emailed and to which address. It derives the recipient from the
--      authoritative database relationship and verifies a caller-supplied user
--      id against that relationship; it never matches on email strings.
--
-- The contract (p_event_type, p_object_id, p_asserted_user_id) is deliberately
-- NOT (user_id, member_id): for officer events there is no member, and two
-- independent identifiers would let a caller assert a pairing. Here p_object_id
-- is the event's object (a member id for membership events, an officer_term id
-- for officer events) and p_asserted_user_id is an assertion the function
-- checks against the record it reads — a mismatch is ineligible, never an error
-- that leaks which half was wrong.
--
-- Rules enforced:
--   · Email-evaluation events are member.create, member.approve_join,
--     officer_invitation.accept and officer_term.end. Anything else returns
--     eligible = false with skip_reason 'unsupported_event'. In particular
--     member.reject_join, member.join_via_invite and collection.publish never
--     yield an address here: R-E3 is final (no rejection mail to an unverified
--     supplied address), R1 sends no joiner mail, and collection lifecycle is
--     in-app only.
--   · Account path: the address is auth.users.email read at evaluation time,
--     used only when email_confirmed_at is not null. public.users.email,
--     members.email and identity_level are never consulted for an account
--     holder (Q-FALLBACK). Missing, unconfirmed, changed-but-unconfirmed or
--     deleted accounts skip with 'unverified_account_email' and no address.
--   · Non-account path (members.user_id is null, member.create/approve_join
--     only): the organizer-supplied members.email may be used for the minimal
--     membership confirmation, returned with assurance 'unverified_supplied'.
--     Missing addresses skip with 'no_recipient'; malformed ones with
--     'invalid_recipient_address'.
--   · Missing member/term rows skip with 'missing_membership_relationship';
--     a null or mismatched asserted user id skips with
--     'ambiguous_recipient_relationship'. Both return no address.
--
-- Privileges: SECURITY DEFINER so the check reads auth.users regardless of the
-- caller's rights; SET search_path = '' with fully qualified references, per
-- repository convention. The sole caller is the notification worker, which
-- connects as the database owner (apps/worker/src/index.ts, SUPABASE_DB_URL),
-- so no grant is needed and none is given: EXECUTE is revoked from public,
-- anon and authenticated, exactly like app.notification_suppression_state()
-- and app.mask_email_address(text). Client roles cannot call this function to
-- enumerate verified addresses — and it is unreachable through PostgREST,
-- which serves the public schema only.
--
-- The P5 sender must re-read the Auth record inside its send lease before
-- dispatching; an evaluation-time address never overrides a dispatch-time
-- read. This function does not send, queue, retry or rate-limit anything.
--
-- Additive. No existing row, table, policy, trigger or function is changed.
-- Rollback: drop the two functions.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Plausibility check ───────────────────────────────────────────────────────
create or replace function app.email_address_usable(p_address text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_address is null then
    return false;
  end if;
  if char_length(p_address) < 3 or char_length(p_address) > 254 then
    return false;
  end if;
  -- No whitespace, control characters or separators anywhere: a value that
  -- could carry a second address, a display name or a header break is unusable.
  if p_address ~ '[[:space:][:cntrl:],;<>"]' then
    return false;
  end if;
  if char_length(split_part(p_address, '@', 1)) < 1
     or char_length(split_part(p_address, '@', 1)) > 64
     or p_address not like '%@%.%' then
    return false;
  end if;
  if split_part(p_address, '@', 1) ~ '(^\.|\.$|\.\.)' then
    return false;
  end if;
  if p_address !~ '^[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]+@[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$' then
    return false;
  end if;
  return true;
end;
$$;

comment on function app.email_address_usable(text) is
  'M13.2 P4: conservative single-mailbox plausibility check used by the eligibility function so a stored address always satisfies the delivery-table guard. No client role may execute it.';

revoke all on function app.email_address_usable(text) from public;
revoke execute on function app.email_address_usable(text) from anon, authenticated;


-- ── The eligibility decision ─────────────────────────────────────────────────
create or replace function app.evaluate_email_eligibility(
  p_event_type       text,
  p_object_id        uuid,
  p_asserted_user_id uuid
)
returns table (eligible boolean, address text, assurance text, skip_reason text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_member_user  uuid;
  v_member_email text;
  v_term_user    uuid;
  v_auth_email   text;
  v_auth_confirmed timestamptz;
begin
  eligible := false;
  address := null;
  assurance := null;
  skip_reason := null;

  -- Only membership confirmations and officer notices are email-evaluation
  -- events. Everything else — rejections, invite redemptions, collection
  -- lifecycle, unwatched actions — yields no address here.
  if p_event_type not in (
    'member.create', 'member.approve_join',
    'officer_invitation.accept', 'officer_term.end'
  ) then
    skip_reason := 'unsupported_event';
    return next;
    return;
  end if;

  if p_event_type in ('member.create', 'member.approve_join') then
    select m.user_id, m.email into v_member_user, v_member_email
      from public.members m where m.id = p_object_id;
    if not found then
      skip_reason := 'missing_membership_relationship';
      return next;
      return;
    end if;

    if v_member_user is not null then
      -- Account path. The asserted id must equal the record's user_id; any
      -- mismatch — or none supplied — is ineligible, never an email match.
      if p_asserted_user_id is null or p_asserted_user_id <> v_member_user then
        skip_reason := 'ambiguous_recipient_relationship';
        return next;
        return;
      end if;
      select u.email::text, u.email_confirmed_at into v_auth_email, v_auth_confirmed
        from auth.users u where u.id = v_member_user;
      -- Never fall back to public.users.email or members.email here (Q-FALLBACK).
      if v_auth_email is null or v_auth_confirmed is null then
        skip_reason := 'unverified_account_email';
        return next;
        return;
      end if;
      if not app.email_address_usable(v_auth_email) then
        skip_reason := 'invalid_recipient_address';
        return next;
        return;
      end if;
      eligible := true;
      address := v_auth_email;
      assurance := 'verified_account';
      return next;
      return;
    end if;

    -- Non-account path: minimal membership confirmation only, recorded as
    -- unverified_supplied and never described as verified anywhere.
    if v_member_email is null then
      skip_reason := 'no_recipient';
      return next;
      return;
    end if;
    if not app.email_address_usable(v_member_email) then
      skip_reason := 'invalid_recipient_address';
      return next;
      return;
    end if;
    eligible := true;
    address := v_member_email;
    assurance := 'unverified_supplied';
    return next;
    return;
  end if;

  -- Officer path: the recipient is the holder of the term this event is about.
  select ot.user_id into v_term_user
    from public.officer_terms ot where ot.id = p_object_id;
  if not found then
    skip_reason := 'missing_membership_relationship';
    return next;
    return;
  end if;
  if p_asserted_user_id is null or p_asserted_user_id <> v_term_user then
    skip_reason := 'ambiguous_recipient_relationship';
    return next;
    return;
  end if;
  select u.email::text, u.email_confirmed_at into v_auth_email, v_auth_confirmed
    from auth.users u where u.id = v_term_user;
  if v_auth_email is null or v_auth_confirmed is null then
    skip_reason := 'unverified_account_email';
    return next;
    return;
  end if;
  if not app.email_address_usable(v_auth_email) then
    skip_reason := 'invalid_recipient_address';
    return next;
    return;
  end if;
  eligible := true;
  address := v_auth_email;
  assurance := 'verified_account';
  return next;
  return;
end;
$$;

comment on function app.evaluate_email_eligibility(text, uuid, uuid) is
  'M13.2 P4: the single email-recipient eligibility decision. Derives the recipient from the member or officer_term record, verifies any asserted user id against it, reads the current auth.users email confirmation state, and returns either an eligible address with its assurance or a stable skip reason with no address. Operator/worker only; no client role may execute it.';

revoke all on function app.evaluate_email_eligibility(text, uuid, uuid) from public;
revoke execute on function app.evaluate_email_eligibility(text, uuid, uuid) from anon, authenticated;
