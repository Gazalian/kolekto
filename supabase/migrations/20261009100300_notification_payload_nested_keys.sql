-- ─────────────────────────────────────────────────────────────────────────────
-- 20261009100300 — Banned payload keys are removed at every depth (M13.2 P2 review, round 2)
--
-- 20261009100200 removed contact-detail and free-text-note keys only at the TOP
-- level of a notification_events payload, and only for exact lower-case names.
-- Re-review found that {"outer": {"reason": "..."}}, an array element carrying
-- "phone", and a key written "EMAIL" all survived — so the claim "banned keys are
-- removed" was broader than the code. This closes it:
--
--   app.strip_banned_payload_keys(jsonb)   recursive, case-insensitive: objects and
--                                          arrays at any depth; other values unchanged
--   app.payload_has_banned_key(jsonb)      true iff stripping would change the payload
--
-- The BEFORE INSERT trigger now calls the strip function; the CHECK constraint is
-- replaced by one that calls the predicate. The email-shaped-text redaction and its
-- identical constraint pattern from 20261009100200 are unchanged.
--
-- Not changed, and stated plainly: VALUES that are not email-shaped (a typed phone
-- number, a free-text name) are kept — people typed them, officers can see them
-- elsewhere, and a value cannot be classified as "sensitive" by pattern. This
-- removes the contact-detail and note KEYS and the email-shaped TEXT, not all text.
--
-- Additive. Existing rows are validated by the new constraint; the only payload
-- keys in any existing row are actor_name and community_id. Rollback: restore
-- the constraint and trigger body from 20261009100200 and drop the two functions.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.strip_banned_payload_keys(p_payload jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_result jsonb;
  v_key    text;
  v_value  jsonb;
begin
  if jsonb_typeof(p_payload) = 'object' then
    v_result := '{}'::jsonb;
    for v_key, v_value in select key, value from jsonb_each(p_payload) loop
      if lower(v_key) = any (array[
        'email', 'email_address', 'phone', 'phone_e164', 'phone_number', 'contact',
        'address', 'recipient', 'recipient_address',
        'reason', 'note', 'notes', 'message', 'comment', 'comments',
        'token', 'password', 'secret', 'before_state', 'after_state'
      ]) then
        continue;
      end if;
      v_result := v_result || jsonb_build_object(v_key, app.strip_banned_payload_keys(v_value));
    end loop;
    return v_result;
  elsif jsonb_typeof(p_payload) = 'array' then
    select coalesce(jsonb_agg(app.strip_banned_payload_keys(e.value) order by e.ordinality), '[]'::jsonb)
      into v_result
      from jsonb_array_elements(p_payload) with ordinality as e(value, ordinality);
    return v_result;
  end if;
  return p_payload;
end;
$$;

comment on function app.strip_banned_payload_keys(jsonb) is
  'M13.2 P2: removes contact-detail and free-text-note keys at ANY depth, case-insensitively, from a notification event payload. Values that are not under a banned key are returned unchanged.';

revoke execute on function app.strip_banned_payload_keys(jsonb) from public, anon, authenticated;


create or replace function app.payload_has_banned_key(p_payload jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select app.strip_banned_payload_keys(p_payload) is distinct from p_payload;
$$;

comment on function app.payload_has_banned_key(jsonb) is
  'M13.2 P2: true iff the payload contains a banned key at any depth. Used by the notification_events_payload_safe constraint.';

revoke execute on function app.payload_has_banned_key(jsonb) from public, anon, authenticated;


-- The trigger: strip at every depth, then redact email-shaped text (unchanged pattern).
create or replace function app.sanitize_notification_event_payload()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if jsonb_typeof(new.payload) = 'object' then
    new.payload := app.strip_banned_payload_keys(new.payload);
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

-- The constraint: same email pattern, banned keys now judged at every depth.
alter table public.notification_events
  drop constraint notification_events_payload_safe;

alter table public.notification_events
  add constraint notification_events_payload_safe
    check (
      jsonb_typeof(payload) = 'object'
      and octet_length(payload::text) <= 8192
      and not app.payload_has_banned_key(payload)
      and payload::text !~ '[^[:space:]"@\\]+@[^[:space:]"@\\]+\.[^[:space:]"@\\]+'
    );

comment on constraint notification_events_payload_safe on public.notification_events is
  'M13.2 P2: payload is an object, <= 8 KiB, with no contact-detail or free-text-note key at any depth and no email-shaped text. The sanitize trigger guarantees this for every insert; the constraint proves it.';
