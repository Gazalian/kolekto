-- ─────────────────────────────────────────────────────────────────────────────
-- 20261007110000 — Notification foundation fixes (M13.1 QA fix pass)
--
-- Additive follow-on to 20261007100000. It is a separate migration (rather than
-- an edit to 100000) because 100000 is already applied to local databases and
-- the fix pass must not reset. Everything here is CREATE OR REPLACE / DROP+CREATE
-- on objects 100000 introduced, so a fresh apply of the whole set is also correct.
--
-- Addresses the independent QA report
-- (docs/product/M13.1-NOTIFICATION-QA-REPORT.md):
--
--   BUG-1  the enqueue trigger listened for audit actions the domain never
--          writes (member.approve, invite_link.redeem). The real actions are
--          member.approve_join and member.join_via_invite. Only collection.publish
--          matched. Corrected below.
--
--   BUG-3  the delivery dedup index keyed on coalesce(recipient_member_id, 0),
--          so distinct officers with a NULL recipient_member_id collapsed to one
--          row. For in-app, identity is the user — the key now falls back to
--          recipient_user_id before the zero sentinel.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── BUG-1: enqueue the audit actions the domain actually writes ──────────────
-- Verified against the domain functions:
--   collection.publish      — app collection transition (20260919120000)
--   member.approve_join      — approve a pending join (20260918140100)
--   member.join_via_invite   — redeem an invite link (20260918140100 et al.)
-- The audit actions are the source of truth; they are NOT renamed.

create or replace function app.enqueue_notification_on_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.community_id is null then
    return new;
  end if;

  if new.action in (
    'collection.publish',
    'member.approve_join',
    'member.join_via_invite'
  ) then
    perform pgmq.send(
      'notification_events',
      jsonb_build_object(
        'audit_log_id', new.id,
        'community_id', new.community_id,
        'action', new.action,
        'actor_type', new.actor_type::text,
        'actor_user_id', new.actor_user_id,
        'actor_name', new.actor_name_snapshot,
        'object_type', new.object_type,
        'object_id', new.object_id,
        'after_state', new.after_state,
        'created_at', new.created_at
      )
    );
  end if;

  return new;
end;
$$;

comment on function app.enqueue_notification_on_audit() is
  'M13.1 (fixed 20261007110000): watches audit_logs INSERTs and enqueues notification-worthy events to the pgmq notification_events queue. Listens for the actions the domain actually writes: collection.publish, member.approve_join, member.join_via_invite.';

revoke all on function app.enqueue_notification_on_audit() from public;


-- ── BUG-3: dedup key must separate distinct in-app recipients ────────────────
-- An in-app delivery always carries recipient_user_id (enforced by the
-- notification_deliveries_in_app_has_user check). When recipient_member_id is
-- NULL (e.g. an officer notified about a new member), the user is the identity.
-- Falling back to recipient_user_id keeps three officers as three deliveries
-- while still blocking a genuine duplicate (same event, same recipient, same
-- channel).

drop index if exists public.notification_deliveries_event_recipient_channel_key;

create unique index notification_deliveries_event_recipient_channel_key
  on public.notification_deliveries (
    notification_event_id,
    coalesce(
      recipient_member_id,
      recipient_user_id,
      '00000000-0000-0000-0000-000000000000'::uuid
    ),
    channel
  );
