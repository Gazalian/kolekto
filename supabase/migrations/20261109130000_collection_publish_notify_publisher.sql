-- ─────────────────────────────────────────────────────────────────────────────
-- Notify the publisher when a collection is published
--
-- Today collection.publish emails the audience MEMBERS (per
-- app.evaluate_collection_email_recipients) and notifies in-app the audience
-- members who have an account. The officer who published it — the publisher —
-- gets nothing by email. This change emails the publisher too, at their
-- confirmed account email, as an essential (transactional) confirmation.
--
-- Additive. Two pieces:
--
--   1. app.evaluate_actor_email(p_user_id uuid)
--        The confirmed account email for one user (the publisher), or a stable
--        skip reason. Mirrors the account path of app.evaluate_email_eligibility
--        (20261012100000): auth.users.email, used only when email_confirmed_at
--        is set; never public.users.email. SECURITY DEFINER; worker-only.
--
--   2. app.recheck_delivery_eligibility is re-created to let a member-less,
--        account-addressed email delivery (recipient_member_id IS NULL and
--        recipient_user_id IS NOT NULL) through as ESSENTIAL. Such a row is a
--        notification to an account holder (an officer / the publisher), not
--        member communication: the opt-out, community-notice and audience gates
--        do not apply to it. The address must still match the account's current
--        confirmed email (anti-staleness), exactly as for a member.
--
--        Before this change the member-less branch returned 'member_unavailable'
--        for every non-essential event. No email delivery reached that branch
--        today: the only member-less email rows are officer notices E4/E5, which
--        are category 'essential' and return NULL earlier. So this is additive:
--        it only newly enables account-addressed essential sends.
--
-- The worker fans out the publisher row only for collection.publish (not
-- reminders or change-announcements), stores communication_category = NULL on
-- it (so the recheck's category-mismatch guard does not fire), send_class
-- 'transactional', and never a second time for an address already queued as an
-- audience member.
--
-- Rollback (additive):
--   drop function app.evaluate_actor_email(uuid);
--   re-create app.recheck_delivery_eligibility from 20261109100200.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. The publisher's confirmed account email ───────────────────────────────
create or replace function app.evaluate_actor_email(p_user_id uuid)
returns table (address text, assurance text, skip_reason text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email     text;
  v_confirmed timestamptz;
begin
  if p_user_id is null then
    return query select null::text, null::text, 'no_recipient'::text;
    return;
  end if;

  select u.email::text, u.email_confirmed_at
    into v_email, v_confirmed
  from auth.users u
  where u.id = p_user_id;

  if v_email is null or v_confirmed is null then
    return query select null::text, null::text, 'unverified_account_email'::text;
    return;
  end if;
  if not app.email_address_usable(v_email) then
    return query select null::text, null::text, 'invalid_recipient_address'::text;
    return;
  end if;

  return query select v_email, 'verified_account'::text, null::text;
end;
$$;

comment on function app.evaluate_actor_email(uuid) is
  'The confirmed account email (auth.users.email with email_confirmed_at set) for one user, used to email the officer who performed an action (e.g. the collection publisher). Returns a stable skip reason otherwise. Never reads public.users.email. SECURITY DEFINER; worker only.';

revoke all on function app.evaluate_actor_email(uuid) from public;
revoke execute on function app.evaluate_actor_email(uuid) from public, anon, authenticated;


-- ── 2. Send-time recheck: account-addressed rows are essential ───────────────
-- Re-created verbatim from 20261109100200 except: (a) the delivery SELECT also
-- reads recipient_user_id, and (b) the member-less branch now admits an
-- account-addressed email row as essential after verifying its address.
create or replace function app.recheck_delivery_eligibility(p_delivery_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_d         record;
  v_policy    record;
  v_req       record;
  v_member    record;
  v_prefs     record;
  v_candidate text;
begin
  select d.id, d.community_id, d.channel::text as channel, d.recipient_member_id, d.recipient_user_id,
         d.recipient_address, d.communication_category, e.event_type, e.object_type, e.object_id
    into v_d
  from public.notification_deliveries d
  join public.notification_events e on e.id = d.notification_event_id
  where d.id = p_delivery_id;

  if v_d.id is null then
    return 'delivery_not_found';
  end if;

  select c.category, c.payment_purpose, c.topic into v_policy
  from app.communication_category_for_event(v_d.event_type) c;
  if v_policy.category is null then
    return 'category_unknown';
  end if;
  if v_d.communication_category is not null and v_d.communication_category <> v_policy.category then
    return 'category_mismatch';
  end if;

  select r.requirement, r.detail into v_req
  from app.communication_requirement(v_policy.category, v_d.channel, v_policy.payment_purpose) r;
  if v_req.requirement is null then
    return 'category_not_on_channel';
  end if;
  if v_req.requirement = 'disabled' then
    return coalesce(v_req.detail, 'category_not_on_channel');
  end if;
  -- Essential (transactional) messages are not optional.
  if v_req.requirement = 'always' then
    return null;
  end if;

  -- Everything below is optional communication addressed to a MEMBER.
  --
  -- A member-less row with an account recipient is NOT member communication:
  -- it is an essential notice to an account holder (an officer / the collection
  -- publisher). The member opt-out, community-notice and audience gates do not
  -- apply. Verify the stored address still matches the account's confirmed
  -- email (an account may have changed it after fan-out), then allow.
  if v_d.recipient_member_id is null then
    if v_d.channel = 'email' and v_d.recipient_user_id is not null then
      select u.email::text into v_candidate
      from auth.users u
      where u.id = v_d.recipient_user_id and u.email_confirmed_at is not null;
      if v_candidate is null or v_d.recipient_address is null
         or lower(v_candidate) <> lower(v_d.recipient_address) then
        return 'recipient_changed';
      end if;
      return null;
    end if;
    return 'member_unavailable';
  end if;

  -- Serialise with in-flight withdrawals and attestation changes.
  perform pg_advisory_xact_lock_shared(hashtextextended('member_communication_choice:' || v_d.recipient_member_id::text, 0));
  perform pg_advisory_xact_lock_shared(hashtextextended('community_communication_attestation:' || v_d.community_id::text, 0));

  select m.id, m.community_id, m.status::text as status, m.archived_at, m.merged_into_id, m.user_id, m.email::text as email
    into v_member
  from public.members m
  where m.id = v_d.recipient_member_id;
  if v_member.id is null
     or v_member.community_id <> v_d.community_id
     or v_member.status in ('archived', 'merged')
     or v_member.archived_at is not null
     or v_member.merged_into_id is not null then
    return 'member_unavailable';
  end if;

  -- The member's own choice first.
  if app.member_communication_opted_out(v_member.id, v_policy.category, v_d.channel) then
    return 'opted_out';
  end if;
  select p.email_enabled, p.whatsapp_enabled, p.sms_enabled,
         case v_policy.topic
           when 'announcement' then p.announcements_enabled
           when 'update'       then p.collection_updates_enabled
           when 'reminder'     then p.reminders_enabled
         end as topic_enabled
    into v_prefs
  from public.notification_preferences p
  where p.member_id = v_member.id and p.community_id = v_member.community_id;
  if (v_d.channel = 'email'    and v_prefs.email_enabled    is false)
     or (v_d.channel = 'whatsapp' and v_prefs.whatsapp_enabled is false)
     or (v_d.channel = 'sms'      and v_prefs.sms_enabled      is false)
     or v_prefs.topic_enabled is false then
    return 'opted_out';
  end if;

  if v_req.requirement = 'default_on' then
    if v_req.detail = 'community_notice'
       and not app.community_communication_notice_attested(v_d.community_id) then
      return 'community_notice_missing';
    end if;
  elsif v_req.requirement = 'opt_in' then
    if position('marketing_consent' in coalesce(v_req.detail, '')) > 0
       and not app.member_communication_permission(v_member.id, 'marketing_consent') then
      return 'marketing_consent_missing';
    end if;
    if position('whatsapp_permission' in coalesce(v_req.detail, '')) > 0
       and not app.member_communication_permission(v_member.id, 'whatsapp_permission') then
      return 'channel_permission_missing';
    end if;
  else
    return 'category_not_on_channel';
  end if;

  -- A collection message must still link to a page a member without an account can open.
  if v_d.object_type = 'collection' and not exists (
       select 1
       from public.collections c
       join public.communities cm on cm.id = c.community_id
       where c.id = v_d.object_id
         and c.community_id = v_d.community_id
         and c.visibility in ('public', 'unlisted')
         and c.status in ('active', 'paused', 'closed')
         and cm.status = 'active') then
    return 'collection_not_reachable';
  end if;

  -- The address the row carries must still be the member's current address.
  if v_d.channel = 'email' then
    if v_member.user_id is not null then
      select u.email::text into v_candidate
      from auth.users u
      where u.id = v_member.user_id and u.email_confirmed_at is not null;
    else
      v_candidate := v_member.email;
    end if;
    if v_candidate is null or v_d.recipient_address is null
       or lower(v_candidate) <> lower(v_d.recipient_address) then
      return 'recipient_changed';
    end if;
  end if;

  return null;
end;
$$;

comment on function app.recheck_delivery_eligibility(uuid) is
  'M13.3 R3 (+ publisher notice): send-time eligibility for one delivery. NULL = may be sent. A member-less, account-addressed email row is essential (an officer / publisher notice): allowed once its address matches the account''s confirmed email. Member rows keep the full opt-out / community-notice / audience / address checks. Essential events always NULL. Internal; no client role may execute it.';

revoke all on function app.recheck_delivery_eligibility(uuid) from public;
revoke execute on function app.recheck_delivery_eligibility(uuid) from public, anon, authenticated;
