-- ─────────────────────────────────────────────────────────────────────────────
-- 20261123130000 — M9b3: member identification by membership ID (Phase A-2)
--
-- Owner decisions of 2026-11-23:
--   · A membership ID is an identifier, like a matric number — not a password.
--     No OTP, challenge or new authentication is added.
--   · Flow: "I'm a member" → type the ID → app.validate_membership_id (already
--     built: canonical match, good standing, audience, DB rate limits, a
--     30-minute pass) → confirmation screen with the full name and a MASKED
--     email and phone → "Yes, continue" → the payment form, name prefilled.
--   · Paystack Option 2: the payer types their own receipt email. The member's
--     stored email and phone are never sent to Paystack and never reach the
--     browser unmasked. Attribution comes from the membership ID only.
--
-- This migration:
--   1. app.mask_email / app.mask_phone — masking helpers. Internal, not granted.
--   2. app.membership_pass_summary(collection, token) — what the confirmation
--      screen shows. Masking happens here, in SQL, so the full email and phone
--      never leave the database on this path.
--   3. app.confirm_membership_pass(collection, token) — "Yes, continue". Live
--      re-check (app.resolve_membership_access_grant) and one masked
--      `membership.identity_confirmed` audit row. Returns the member id to the
--      server action, which then sets the signed contributor-session cookie.
--   4. Revokes anon / authenticated EXECUTE on app.find_collection_member
--      (owner decision D4: no anonymous search by name, email or phone). The
--      function itself stays, unchanged, for internal use.
--
-- What it does NOT do: no table, column, index, trigger or row is created or
-- changed. No payment, capture, settlement, ledger, reconciliation, withdrawal
-- or transfer function is touched. No guest path (that is A-2b, separately).
--
-- Rollback (nothing is lost; no data is written by this migration):
--   drop function app.confirm_membership_pass(uuid, text);
--   drop function app.membership_pass_summary(uuid, text);
--   drop function app.mask_phone(text);
--   drop function app.mask_email(text);
--   grant execute on function app.find_collection_member(uuid, text) to anon, authenticated;
--   delete from supabase_migrations.schema_migrations where version = '20261123130000';
-- Audit rows written by confirm_membership_pass while it was live stay as
-- history (audit rows are never deleted).
-- ─────────────────────────────────────────────────────────────────────────────


-- ══ 1. Masking helpers (internal) ════════════════════════════════════════════

-- "aisha@gmail.com" → "a•••@gmail.com". Null when there is no usable address.
create or replace function app.mask_email(p_email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_email is null or position('@' in p_email) < 2 then null
    else left(p_email, 1) || '•••@' || split_part(p_email, '@', 2)
  end;
$$;

comment on function app.mask_email(text) is
  'M9b3. First character, a fixed mask and the domain: a•••@gmail.com. The mask length never reflects the real length. Internal; not granted.';

-- "+2348012345567" → "+234 ••• ••• •567". Other countries: "+••• ••• •567".
-- Null when there is no number. Only the last three digits are ever shown.
create or replace function app.mask_phone(p_phone text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_phone is null or char_length(p_phone) < 7 then null
    when p_phone like '+234%' then '+234 ••• ••• •' || right(p_phone, 3)
    else '+••• ••• •' || right(p_phone, 3)
  end;
$$;

comment on function app.mask_phone(text) is
  'M9b3. Fixed mask plus the last three digits: +234 ••• ••• •567 (Nigerian numbers keep +234). Internal; not granted.';

revoke all on function app.mask_email(text) from public, anon, authenticated;
revoke all on function app.mask_phone(text) from public, anon, authenticated;


-- ══ 2. Confirmation screen ═══════════════════════════════════════════════════

create or replace function app.membership_pass_summary(p_collection_id uuid, p_token text)
returns table (full_name text, email_masked text, phone_masked text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_member_id uuid;
begin
  -- Every live check (expiry, revocation, ID still live, good standing,
  -- audience, collection and community active) is in the resolver. An unknown,
  -- expired, revoked or other-collection token gives no row — the same answer.
  v_member_id := app.resolve_membership_access_grant(p_collection_id, p_token);
  if v_member_id is null then
    return;
  end if;

  return query
  select m.full_name, app.mask_email(m.email::text), app.mask_phone(m.phone_e164)
  from public.members m
  where m.id = v_member_id;
end;
$$;

comment on function app.membership_pass_summary(uuid, text) is
  'M9b3 (A-2). For a live membership pass on this collection: the member''s full name and a masked email and phone, masked here so the full values never leave the database. No row for any bad, expired or other-collection token. Never returns the member id, the membership ID or an unmasked contact.';


-- ══ 3. "Yes, continue" ═══════════════════════════════════════════════════════

create or replace function app.confirm_membership_pass(p_collection_id uuid, p_token text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_member_id    uuid;
  v_grant        public.membership_access_grants%rowtype;
  v_masked       text;
begin
  v_member_id := app.resolve_membership_access_grant(p_collection_id, p_token);
  if v_member_id is null then
    return null;
  end if;

  -- The resolver accepted this exact token, so the lookup below finds its row.
  select * into v_grant
  from public.membership_access_grants g
  where g.token_hash = extensions.digest(p_token, 'sha256')
    and g.collection_id = p_collection_id;

  select mi.prefix || mi.separator || '…' || mi.last2 into v_masked
  from public.membership_ids mi
  where mi.id = v_grant.membership_id_id;

  -- Masked ID only. No plaintext ID, email, phone or token in the audit row.
  perform app.write_audit_log(
    v_grant.community_id, 'contributor', null, 'membership.identity_confirmed', 'member', v_member_id,
    null,
    jsonb_build_object('collection_id', p_collection_id, 'membership_id_id', v_grant.membership_id_id, 'masked', v_masked),
    null, null, null
  );

  return v_member_id;
end;
$$;

comment on function app.confirm_membership_pass(uuid, text) is
  'M9b3 (A-2). The contributor said "yes, these are my details". Re-checks the pass live and writes one masked membership.identity_confirmed audit row; returns the member id to the server (never to the browser), or null. A confirmation is the person''s own statement, not proof of identity: the membership ID is an identifier, not a secret.';


-- ══ 4. Grants ════════════════════════════════════════════════════════════════

revoke all on function app.membership_pass_summary(uuid, text) from public;
revoke all on function app.confirm_membership_pass(uuid, text) from public;
grant execute on function app.membership_pass_summary(uuid, text) to anon, authenticated;
grant execute on function app.confirm_membership_pass(uuid, text) to anon, authenticated;

-- Owner decision D4: anonymous search by name, email or phone is removed. The
-- only way a stranger can reach a member is an exact membership ID, through
-- app.validate_membership_id and its database rate limits.
revoke execute on function app.find_collection_member(uuid, text) from anon, authenticated;
