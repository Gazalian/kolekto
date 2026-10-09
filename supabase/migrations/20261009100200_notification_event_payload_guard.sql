-- ─────────────────────────────────────────────────────────────────────────────
-- 20261009100200 — Notification event payloads cannot carry addresses (M13.2 P2 review)
--
-- Found in the pre-P3 security review. notification_events is readable by EVERY
-- officer of a community, viewer and collector included
-- (notification_events_select_officer, M13.1), and that is unchanged. Its
-- `payload` is therefore visible to roles that must not see email addresses.
-- Until now payloads held only names and slugs because the worker happens to
-- build them that way: a convention, not a guarantee, and P3 is about to add
-- code that handles addresses.
--
-- This makes it a guarantee in the database, in two layers:
--
--   1. A BEFORE INSERT trigger REDACTS rather than rejects: top-level keys that
--      could carry contact details or officer free text are removed, and any
--      email-shaped text inside any string value is replaced with
--      "[email removed]". Redacting matters: a payload value such as
--      member_name is typed by a person, and a person can type an email address
--      as their name. Rejecting that row would make the worker fail on it
--      forever (a failed queue message is never dropped — decision record §10.4),
--      which would turn a hardening change into an outage.
--   2. A CHECK constraint using the IDENTICAL pattern proves the result: a
--      payload is a JSON object, within 8 KiB, with none of the banned keys and
--      no email-shaped text. Because the trigger always runs first, the only
--      payloads the constraint can reject are non-objects and oversized ones.
--
-- What this does NOT do: payloads may still hold names, member codes and
-- collection names (people typed them; officers can already see them elsewhere).
-- It removes the contact-detail and free-text-note classes, not all free text.
--
-- Additive. No existing row is modified (the table is append-only); existing rows
-- are validated by the new constraint and must satisfy it — the local and
-- hosted payloads contain only `actor_name` and `community_id`. Rollback: drop
-- the trigger, the function and the constraint.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.sanitize_notification_event_payload()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if jsonb_typeof(new.payload) = 'object' then
    new.payload := new.payload - array[
      'email', 'phone', 'phone_e164', 'address', 'recipient', 'recipient_address',
      'reason', 'note', 'notes', 'message', 'comment', 'token', 'password', 'secret',
      'before_state', 'after_state'
    ];
    -- The class excludes whitespace, double quote and backslash, so a match can
    -- never span a JSON string boundary: the result is always valid JSON.
    new.payload := regexp_replace(
      new.payload::text,
      '[^[:space:]"@\\]+@[^[:space:]"@\\]+\.[^[:space:]"@\\]+',
      '[email removed]',
      'g'
    )::jsonb;
  end if;
  return new;
end;
$$;

comment on function app.sanitize_notification_event_payload() is
  'M13.2 P2: BEFORE INSERT on notification_events. Removes contact-detail / free-text-note keys and redacts email-shaped text so no officer can read an address through an event payload. Redacts, never rejects: a person can type an email address as their name.';

revoke execute on function app.sanitize_notification_event_payload() from public, anon, authenticated;

create trigger notification_events_sanitize_payload
  before insert on public.notification_events
  for each row execute function app.sanitize_notification_event_payload();

alter table public.notification_events
  add constraint notification_events_payload_safe
    check (
      jsonb_typeof(payload) = 'object'
      and octet_length(payload::text) <= 8192
      and not (payload ?| array[
        'email', 'phone', 'phone_e164', 'address', 'recipient', 'recipient_address',
        'reason', 'note', 'notes', 'message', 'comment', 'token', 'password', 'secret',
        'before_state', 'after_state'
      ])
      and payload::text !~ '[^[:space:]"@\\]+@[^[:space:]"@\\]+\.[^[:space:]"@\\]+'
    );

comment on constraint notification_events_payload_safe on public.notification_events is
  'M13.2 P2: payload is an object, <= 8 KiB, with no contact-detail or free-text-note keys and no email-shaped text. The sanitize trigger guarantees this for every insert; the constraint proves it.';
