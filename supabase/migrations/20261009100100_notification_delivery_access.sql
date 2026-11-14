-- ─────────────────────────────────────────────────────────────────────────────
-- 20261009100100 — Delivery-record access and constraints (M13.2 P2)
--
-- Closes the M13.1 gap that must be closed BEFORE the first email delivery row is
-- written (docs/product/M13.2-EMAIL-NOTIFICATIONS-DECISION-RECORD.md §2.4, §9):
--
--   notification_deliveries_select_officer let EVERY current officer of a
--   community, of any role, read EVERY delivery row — including, once email
--   exists, recipient addresses and error detail. And app.has_permission ignores
--   role_permissions.scoped, so collector and viewer (who hold member.view_contact)
--   pass any check an admin passes for a permission they hold. member.view_contact
--   therefore cannot gate this; a dedicated permission can, because only owner and
--   admin are given it.
--
-- What this migration does:
--
--   1. Adds the catalogue permission notification.view_delivery_log, granted to
--      owner and admin ONLY, through the existing permissions / role_permissions
--      tables (ADR 0008). No parallel authorisation mechanism.
--   2. Drops the broad officer SELECT policy. No policy grants any officer a row
--      of notification_deliveries. A user still reads their own in-app inbox
--      (notification_deliveries_select_own_inbox, unchanged), which is all the
--      notification bell queries.
--   3. Adds app.list_email_delivery_log(): the ONLY way an officer sees email
--      deliveries. Permission-checked, community-scoped, returns a MASKED address,
--      a stable reason code and counters — never the address, never error_message.
--   4. Adds columns for the contact-assurance level and a de-duplication key, and
--      constraints that make the properties the decision record promises true in
--      the database, not just in the sender: a sendable email row carries a valid
--      address; a skipped row carries none; failed/dead/skipped rows carry a stable
--      reason code; raw provider error text cannot be stored at all.
--
-- Additive and reversible. No row is rewritten. Every new constraint is satisfied
-- by every row that can exist today (M13.1 wrote in_app rows only, with no
-- address, no error text and status 'sent'), and the migration asserts that
-- before adding them. Rollback, if ever needed before any email row exists, is:
-- drop the new constraints/index/columns/functions, re-create the officer policy
-- from 20261007100000 lines 228-236, and delete the two role_permissions rows
-- and the permissions row. Do NOT roll back after email rows exist: that would
-- re-open officer access to addresses.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Safety check: existing rows must satisfy the new constraints ─────────────
-- M13.1 only ever wrote in_app rows. If anything else is present the new
-- constraints would fail halfway; fail early with a clear message instead.
do $$
declare
  v_bad bigint;
begin
  select count(*) into v_bad
  from public.notification_deliveries
  where channel <> 'in_app'
     or recipient_address is not null
     or error_message is not null
     or provider_message_id is not null
     or (error_code is not null and error_code !~ '^[a-z][a-z0-9_]{2,63}$');

  if v_bad > 0 then
    raise exception
      'M13.2 P2 PRECONDITION: % notification_deliveries row(s) are not plain in-app rows; review them before applying this migration', v_bad
      using errcode = 'P0001';
  end if;
end;
$$;


-- ── 1. The permission ────────────────────────────────────────────────────────
insert into public.permissions (key, description) values
  ('notification.view_delivery_log',
   'See the email delivery log: masked recipients, outcomes and reason codes. Never raw addresses or provider errors');

insert into public.role_permissions (role, permission) values
  ('owner', 'notification.view_delivery_log'),
  ('admin', 'notification.view_delivery_log');


-- ── 2. Remove the broad officer policy ───────────────────────────────────────
drop policy if exists notification_deliveries_select_officer on public.notification_deliveries;

comment on table public.notification_deliveries is
  'M13.1: one row per (event × recipient × channel). M13.2 P2: the ONLY policy granting SELECT is notification_deliveries_select_own_inbox (a user''s own in-app rows). Officers read email deliveries only through app.list_email_delivery_log(), which masks the address and never returns error text.';


-- ── 3. New columns ───────────────────────────────────────────────────────────
alter table public.notification_deliveries
  add column recipient_address_assurance text,
  add column dedupe_key text;

comment on column public.notification_deliveries.recipient_address_assurance is
  'How much is known about recipient_address. verified_account = the address GoTrue has confirmed for the recipient''s account. unverified_supplied = an address someone typed (an officer, or the person joining); it is NEVER described as verified anywhere. There is deliberately no third value until a contact-verification mechanism exists (decision record §7).';
comment on column public.notification_deliveries.dedupe_key is
  'Optional key making equivalent deliveries collapse to one, e.g. membership_confirmation:{member_id} so being added, joining and being approved yield one email. Unique per (community, channel) where set.';
comment on column public.notification_deliveries.error_message is
  'DEPRECATED, always NULL (enforced). Raw provider error text must never be stored: it can echo a recipient''s address and is readable by operators. Use error_code, a stable Kolekto reason code.';


-- ── 4. Constraints ───────────────────────────────────────────────────────────
-- M13.1's failed_has_reason demanded an error_message. That is exactly what must
-- never be stored, so it is replaced by a requirement for a stable code.
alter table public.notification_deliveries
  drop constraint notification_deliveries_failed_has_reason;

alter table public.notification_deliveries
  add constraint notification_deliveries_no_raw_error_text
    check (error_message is null),

  -- Stable, snake_case reason vocabulary. A raw provider string (spaces, capitals,
  -- punctuation, an address) cannot satisfy this.
  add constraint notification_deliveries_error_code_format
    check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{2,63}$'),

  -- An outcome that is not "worked" must say why, in the stable vocabulary.
  add constraint notification_deliveries_unsuccessful_has_code
    check (status not in ('failed', 'dead', 'skipped') or error_code is not null),

  add constraint notification_deliveries_assurance_values
    check (recipient_address_assurance is null
           or recipient_address_assurance in ('verified_account', 'unverified_supplied')),

  -- In-app rows are addressed by user and never carry contact details or
  -- provider data.
  add constraint notification_deliveries_in_app_has_no_contact
    check (channel <> 'in_app'
           or (recipient_address is null
               and recipient_address_assurance is null
               and provider_message_id is null)),

  -- A sendable email row (anything but 'skipped') carries a plausible single
  -- address and says how much is known about it. This mirrors the adapter's
  -- own validation (packages/adapters/src/email-provider.ts): one mailbox, no
  -- whitespace, control or separator characters, bounded length. A plausible-
  -- address check, not proof that the mailbox exists.
  add constraint notification_deliveries_email_has_valid_address
    check (channel <> 'email'
           or status = 'skipped'
           or (recipient_address is not null
               and recipient_address_assurance is not null
               and char_length(recipient_address) <= 254
               and char_length(split_part(recipient_address, '@', 1)) <= 64
               and recipient_address ~ '^[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]+@[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$'
               and recipient_address !~ '\.\.'
               and split_part(recipient_address, '@', 1) !~ '^\.|\.$')),

  -- A skipped email never had a usable destination or was not allowed to use it;
  -- storing the address would only widen who can learn it.
  add constraint notification_deliveries_skipped_email_has_no_address
    check (not (channel = 'email' and status = 'skipped')
           or (recipient_address is null and recipient_address_assurance is null)),

  add constraint notification_deliveries_dedupe_key_format
    check (dedupe_key is null or dedupe_key ~ '^[a-z][a-z_]{2,40}:[A-Za-z0-9-]{1,100}$');

-- Equivalent deliveries collapse to one. Partial: most rows have no key.
create unique index notification_deliveries_dedupe_key_key
  on public.notification_deliveries (community_id, channel, dedupe_key)
  where dedupe_key is not null;


-- ── 5. Masking ───────────────────────────────────────────────────────────────
-- first character of the local part, then ***, then the domain: a***@example.com.
-- Internal helper; not callable by any client role.
create or replace function app.mask_email_address(p_address text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_address is null then null
    when position('@' in p_address) < 2 then '***'
    else left(p_address, 1) || '***@' || split_part(p_address, '@', 2)
  end;
$$;

comment on function app.mask_email_address(text) is
  'M13.2 P2: a***@example.com. Used by the delivery-log read function so the full address never leaves the database through an officer-facing path.';

revoke execute on function app.mask_email_address(text) from public, anon, authenticated;


-- ── 6. The controlled read: the ONLY officer path to email deliveries ────────
create or replace function app.list_email_delivery_log(
  p_community_id uuid,
  p_limit        integer     default 50,
  p_before       timestamptz default null
)
returns table (
  id                        uuid,
  notification_event_id     uuid,
  event_type                text,
  channel                   public.notification_channel,
  status                    public.notification_delivery_status,
  recipient_address_masked  text,
  recipient_address_assurance text,
  error_code                text,
  attempt_count             integer,
  created_at                timestamptz,
  last_attempted_at         timestamptz,
  next_retry_at             timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- Raises 42501 for anon, for every role without the permission (treasurer,
  -- collector, viewer), for members, and for officers of other communities.
  perform app.require_permission(p_community_id, 'notification.view_delivery_log');

  return query
  select d.id,
         d.notification_event_id,
         e.event_type,
         d.channel,
         d.status,
         app.mask_email_address(d.recipient_address),
         d.recipient_address_assurance,
         d.error_code,
         d.attempt_count,
         d.created_at,
         d.last_attempted_at,
         d.next_retry_at
  from public.notification_deliveries d
  join public.notification_events e on e.id = d.notification_event_id
  where d.community_id = p_community_id
    and d.channel <> 'in_app'
    and (p_before is null or d.created_at < p_before)
  order by d.created_at desc, d.id desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;

comment on function app.list_email_delivery_log(uuid, integer, timestamptz) is
  'M13.2 P2. Requires notification.view_delivery_log (owner, admin). Returns the community''s non-in-app deliveries with the address MASKED and only the stable error_code; never the full address, never error text, never provider ids. Newest first, at most 200 per call.';

revoke execute on function app.list_email_delivery_log(uuid, integer, timestamptz) from public, anon;
grant  execute on function app.list_email_delivery_log(uuid, integer, timestamptz) to authenticated;
