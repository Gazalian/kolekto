-- ─────────────────────────────────────────────────────────────────────────────
-- 20260920120100 — Member identity: write functions
--
-- Same contract as every other write function here (ADR 0008, SEC-17): SECURITY
-- DEFINER, re-checks app.has_permission, re-derives tenancy from the row, audits
-- before returning. `authenticated` still holds no INSERT, UPDATE or DELETE on
-- any table.
--
-- Three of these replace Phase 2 functions rather than joining them:
-- create_member, update_member and redeem_invite_link all wrote
-- `members.attributes` and `members.identifier`, neither of which exists any
-- more. A caller still passes a jsonb map of key to value, and those values now
-- land in member_attribute_values, validated against the community's own
-- definitions. The separate `p_identifier` argument is gone: a community's
-- identifying field is one of its own definitions, marked primary, so it
-- arrives in that same map rather than through a parameter that only one field
-- could ever use.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Issuing a code ───────────────────────────────────────────────────────────
-- The UPDATE takes a row lock on the settings row for the rest of the
-- transaction, so two concurrent member creations in one community serialise
-- here and receive consecutive numbers. This is the whole anti-race mechanism,
-- and it is why nothing resembling `max(number) + 1` appears anywhere.
create or replace function app.next_member_code(p_community_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prefix  text;
  v_padding smallint;
  v_number  bigint;
begin
  insert into public.community_member_code_settings (community_id)
  values (p_community_id)
  on conflict (community_id) do nothing;

  update public.community_member_code_settings
  set next_number = next_number + 1
  where community_id = p_community_id
  returning prefix, padding, next_number - 1
  into v_prefix, v_padding, v_number;

  if v_number is null then
    raise exception 'NOT_FOUND: community % has no member code settings', p_community_id
      using errcode = 'P0002';
  end if;

  return coalesce(v_prefix, '') || lpad(v_number::text, v_padding, '0');
end;
$$;

comment on function app.next_member_code(uuid) is
  'Issues the next community member code (KWASU/0021). Serialised by the row lock the UPDATE takes, so concurrent creation cannot produce the same code twice. Never called from a browser.';


-- ── Writing attribute values ─────────────────────────────────────────────────
-- Takes the same jsonb map the previous `members.attributes` column held, and
-- turns it into rows — validating each key against the community's definitions
-- on the way. A key with no definition is rejected rather than stored: the
-- definition is what gives a value meaning, and a value whose meaning is only
-- its label is the thing this phase set out to stop.
--
-- Omitting a key leaves that attribute untouched; passing an empty string
-- clears it. That distinction matters for an edit form that only sends the
-- fields it showed.
create or replace function app.set_member_attributes(
  p_member_id  uuid,
  p_attributes jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_community_id uuid;
  v_entry        record;
  v_definition   public.member_attribute_definitions%rowtype;
  v_value        text;
begin
  select community_id into v_community_id from public.members where id = p_member_id;
  if v_community_id is null then
    raise exception 'NOT_FOUND: member % does not exist', p_member_id using errcode = 'P0002';
  end if;

  if p_attributes is null or jsonb_typeof(p_attributes) <> 'object' then
    return;
  end if;

  for v_entry in select key, value from jsonb_each_text(p_attributes)
  loop
    select * into v_definition
    from public.member_attribute_definitions
    where community_id = v_community_id and key = v_entry.key;

    if v_definition.id is null then
      raise exception 'UNKNOWN_MEMBER_FIELD: this community has no member field called "%"', v_entry.key
        using errcode = 'P0001',
              hint = 'Define the field in community settings first.';
    end if;

    v_value := nullif(trim(coalesce(v_entry.value, '')), '');

    if v_value is null then
      delete from public.member_attribute_values
      where member_id = p_member_id and definition_id = v_definition.id;
      continue;
    end if;

    if char_length(v_value) > 200 then
      raise exception 'INVALID_MEMBER_FIELD: % must be 200 characters or fewer', v_definition.label
        using errcode = 'P0001';
    end if;

    if v_definition.type = 'number' and v_value !~ '^-?\d+(\.\d+)?$' then
      raise exception 'INVALID_MEMBER_FIELD: % must be a number', v_definition.label
        using errcode = 'P0001';
    end if;

    if v_definition.type = 'date' and v_value !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'INVALID_MEMBER_FIELD: % must be a date, as YYYY-MM-DD', v_definition.label
        using errcode = 'P0001';
    end if;

    if v_definition.type = 'single_select'
       and not (v_value = any (coalesce(v_definition.options, '{}'::text[]))) then
      raise exception 'INVALID_MEMBER_FIELD: "%" is not one of the options for %', v_value, v_definition.label
        using errcode = 'P0001';
    end if;

    -- The unique index is what actually prevents two members sharing a matric
    -- number; this is the readable refusal in front of it, naming the member
    -- already holding the value so an officer can go and look.
    if v_definition.is_unique and exists (
      select 1 from public.member_attribute_values existing
      where existing.definition_id = v_definition.id
        and existing.value_norm = lower(v_value)
        and existing.member_id <> p_member_id
    ) then
      raise exception 'DUPLICATE_MEMBER_FIELD: another member already has the % "%"', v_definition.label, v_value
        using errcode = 'P0001',
              hint = 'Open that member instead, or correct the value.';
    end if;

    insert into public.member_attribute_values (member_id, definition_id, community_id, value_text, value_norm)
    values (p_member_id, v_definition.id, v_community_id, v_value, lower(v_value))
    on conflict (member_id, definition_id) do update
      set value_text = excluded.value_text,
          value_norm = excluded.value_norm;
  end loop;
end;
$$;

comment on function app.set_member_attributes(uuid, jsonb) is
  'Validates a key-to-value map against the community''s member_attribute_definitions and stores it as rows. An omitted key is left alone; an empty value clears it. Never granted to a client role — called from within the member write functions.';


-- ── Duplicate detection (MEM-08, and the revised brief''s §7) ────────────────
-- Read-only, and deliberately separate from creation: the UI asks this BEFORE
-- submitting, so a possible duplicate can be shown to a person who then decides.
-- Creation asks it again, because a check the client performed is not a check.
--
-- Two strengths, and the difference is whether a human should be able to
-- proceed. A shared phone number is ordinary in a household (the members table
-- says so, and deliberately does not make phone unique); a shared unique
-- identifier is not ordinary at all, and is refused elsewhere by the index.
create or replace function app.find_member_duplicates(
  p_community_id uuid,
  p_full_name    text default null,
  p_phone_e164   text default null,
  p_email        extensions.citext default null,
  p_attributes   jsonb default '{}'::jsonb,
  p_exclude_member_id uuid default null
)
returns table (
  member_id     uuid,
  full_name     text,
  member_code   text,
  status        public.member_status,
  match_reason  text,
  match_strength text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_phone text := app.normalise_phone(p_phone_e164);
begin
  perform app.require_permission(p_community_id, 'member.create');

  return query
  with candidates as (
    -- A unique attribute value already held by someone else. The strongest
    -- signal there is: the community itself declared this field identifying.
    select m.id, m.full_name, m.member_code, m.status,
           format('%s "%s" already belongs to this member', d.label, v.value_text) as reason,
           'exact'::text as strength
    from jsonb_each_text(coalesce(p_attributes, '{}'::jsonb)) as supplied(key, value)
    join public.member_attribute_definitions d
      on d.community_id = p_community_id and d.key = supplied.key and d.is_unique
    join public.member_attribute_values v
      on v.definition_id = d.id and v.value_norm = lower(trim(supplied.value))
    join public.members m on m.id = v.member_id
    where nullif(trim(supplied.value), '') is not null

    union all

    select m.id, m.full_name, m.member_code, m.status,
           'Same phone number' as reason, 'possible'::text as strength
    from public.members m
    where v_phone is not null
      and m.community_id = p_community_id
      and m.phone_e164 = v_phone

    union all

    select m.id, m.full_name, m.member_code, m.status,
           'Same email address' as reason, 'possible'::text as strength
    from public.members m
    where p_email is not null
      and m.community_id = p_community_id
      and m.email = p_email

    union all

    select m.id, m.full_name, m.member_code, m.status,
           'Same name' as reason, 'possible'::text as strength
    from public.members m
    where p_full_name is not null
      and m.community_id = p_community_id
      and lower(trim(m.full_name)) = lower(trim(p_full_name))
  )
  select distinct on (c.id, c.strength)
         c.id, c.full_name, c.member_code, c.status, c.reason, c.strength
  from candidates c
  where c.status <> 'merged'
    and (p_exclude_member_id is null or c.id <> p_exclude_member_id)
  order by c.id, c.strength, c.reason;
end;
$$;

comment on function app.find_member_duplicates is
  'Possible and exact duplicate candidates for a member about to be created. Never merges anything and never blocks on its own — CON-27: a merge is a deliberate act, never automatic.';


-- ── create_member, replaced ──────────────────────────────────────────────────
-- Phase 2''s version wrote members.attributes and issued no code. This one
-- issues the community code, stores attributes as rows, and refuses a possible
-- duplicate unless the caller has seen it and said so.
drop function if exists app.create_member(uuid, text, text, extensions.citext, text, jsonb, uuid[]);
drop function if exists app.update_member(uuid, text, text, extensions.citext, text, jsonb);

create or replace function app.create_member(
  p_community_id uuid,
  p_full_name    text,
  p_phone_e164   text default null,
  p_email        extensions.citext default null,
  p_attributes   jsonb default '{}'::jsonb,
  p_group_ids    uuid[] default '{}',
  p_confirm_possible_duplicate boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member_id uuid;
  v_phone     text := app.normalise_phone(p_phone_e164);
  v_group_id  uuid;
  v_duplicate record;
begin
  perform app.require_permission(p_community_id, 'member.create');

  if p_phone_e164 is not null and v_phone is null then
    raise exception 'INVALID_PHONE: % is not a recognisable phone number', p_phone_e164 using errcode = 'P0001';
  end if;
  if char_length(coalesce(p_full_name, '')) < 1 or char_length(p_full_name) > 120 then
    raise exception 'INVALID_NAME: member name must be 1 to 120 characters' using errcode = 'P0001';
  end if;

  -- §43: an exact duplicate stops, whatever the caller says. A possible one
  -- stops once, and proceeds if the caller comes back having decided.
  for v_duplicate in
    select * from app.find_member_duplicates(p_community_id, p_full_name, p_phone_e164, p_email, p_attributes)
  loop
    if v_duplicate.match_strength = 'exact' then
      raise exception 'DUPLICATE_MEMBER: % (%). %',
        v_duplicate.full_name, coalesce(v_duplicate.member_code, 'no code'), v_duplicate.match_reason
        using errcode = 'P0001',
              hint = 'Open the existing member instead of creating a second record for the same person.';
    elsif not p_confirm_possible_duplicate then
      raise exception 'POSSIBLE_DUPLICATE_MEMBER: % (%). %',
        v_duplicate.full_name, coalesce(v_duplicate.member_code, 'no code'), v_duplicate.match_reason
        using errcode = 'P0001',
              hint = 'Review the existing member. Add this one anyway only if they are genuinely different people.';
    end if;
  end loop;

  v_member_id := app.uuid_generate_v7();

  insert into public.members (
    id, community_id, full_name, phone_e164, email, member_code,
    status, joined_via, created_by
  ) values (
    v_member_id, p_community_id, p_full_name, v_phone, p_email,
    app.next_member_code(p_community_id),
    'unclaimed', 'manual', auth.uid()
  );

  perform app.set_member_attributes(v_member_id, p_attributes);

  foreach v_group_id in array coalesce(p_group_ids, '{}')
  loop
    insert into public.member_group_memberships (member_id, group_id, added_by)
    select v_member_id, id, auth.uid()
    from public.member_groups
    where id = v_group_id and community_id = p_community_id;
  end loop;

  perform app.write_audit_log(
    p_community_id, 'officer', auth.uid(), 'member.create', 'member', v_member_id,
    null, jsonb_build_object('full_name', p_full_name,
                             'member_code', (select member_code from public.members where id = v_member_id))
  );

  return v_member_id;
end;
$$;

comment on function app.create_member is
  'member.create (MEM-*). Issues the community member code, stores community-defined attributes as rows, and refuses duplicates — an exact one always, a possible one until the caller confirms. Group ids outside the community are ignored rather than trusted (SEC-18).';


-- ── update_member, replaced ──────────────────────────────────────────────────
create or replace function app.update_member(
  p_member_id  uuid,
  p_full_name  text,
  p_phone_e164 text default null,
  p_email      extensions.citext default null,
  p_attributes jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.members%rowtype;
  v_phone  text := app.normalise_phone(p_phone_e164);
  v_before jsonb;
begin
  select * into v_member from public.members where id = p_member_id;
  if v_member.id is null then
    raise exception 'NOT_FOUND: member % does not exist', p_member_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_member.community_id, 'member.edit');

  if p_phone_e164 is not null and v_phone is null then
    raise exception 'INVALID_PHONE: % is not a recognisable phone number', p_phone_e164 using errcode = 'P0001';
  end if;
  if char_length(coalesce(p_full_name, '')) < 1 or char_length(p_full_name) > 120 then
    raise exception 'INVALID_NAME: member name must be 1 to 120 characters' using errcode = 'P0001';
  end if;

  v_before := to_jsonb(v_member);

  update public.members set
    full_name  = p_full_name,
    phone_e164 = v_phone,
    email      = p_email
  where id = p_member_id;

  perform app.set_member_attributes(p_member_id, p_attributes);

  perform app.write_audit_log(
    v_member.community_id, 'officer', auth.uid(), 'member.update', 'member', p_member_id,
    v_before, (select to_jsonb(m) from public.members m where m.id = p_member_id)
  );
end;
$$;

comment on function app.update_member is
  'member.edit. The member code is not editable: it identifies the person on receipts and in other people''s records.';


-- ── restore_member (§8, §42) ─────────────────────────────────────────────────
-- Archiving is reversible, and the reverse needs to be an explicit, audited act
-- rather than an edit that happens to change a status column.
--
-- A restored member returns to 'active' only if they still satisfy what 'active'
-- means (PRD 3.3: a verified phone number). Without one they return to
-- 'unclaimed', which is the honest state — not a quiet promotion.
create or replace function app.restore_member(
  p_member_id uuid,
  p_reason    text default null
)
returns public.member_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.members%rowtype;
  v_status public.member_status;
begin
  select * into v_member from public.members where id = p_member_id;
  if v_member.id is null then
    raise exception 'NOT_FOUND: member % does not exist', p_member_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_member.community_id, 'member.archive');

  if v_member.status <> 'archived' then
    raise exception 'NOT_ARCHIVED: this member is %, so there is nothing to restore', v_member.status
      using errcode = 'P0001';
  end if;

  v_status := case when v_member.phone_e164 is not null then 'active' else 'unclaimed' end;

  update public.members
  set status = v_status, archived_at = null
  where id = p_member_id;

  perform app.write_audit_log(
    v_member.community_id, 'officer', auth.uid(), 'member.restore', 'member', p_member_id,
    jsonb_build_object('status', 'archived'), jsonb_build_object('status', v_status), p_reason
  );

  return v_status;
end;
$$;

comment on function app.restore_member(uuid, text) is
  '§42: archiving is reversible and nothing is deleted, so restoring is a status change plus an audit row. Obligations and history were never touched by the archive and are not touched here.';


-- ── Community configuration: the code format ─────────────────────────────────
create or replace function app.update_member_code_settings(
  p_community_id    uuid,
  p_prefix          text default null,
  p_padding         smallint default 4,
  p_starting_number bigint default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before jsonb;
  v_prefix text := nullif(trim(coalesce(p_prefix, '')), '');
  v_next   bigint;
begin
  perform app.require_permission(p_community_id, 'community.edit_profile');

  insert into public.community_member_code_settings (community_id)
  values (p_community_id)
  on conflict (community_id) do nothing;

  select to_jsonb(s), s.next_number into v_before, v_next
  from public.community_member_code_settings s
  where s.community_id = p_community_id;

  -- CODE-04's reasoning, applied to member codes: a sequence may be moved
  -- forward but never backward, because a code already printed on a card or
  -- quoted in a message must never be issued to a second person.
  if p_starting_number is not null and p_starting_number < v_next then
    raise exception 'SEQUENCE_WOULD_REUSE_CODES: the next number is already %, and moving it back would reissue codes already given out', v_next
      using errcode = 'P0001';
  end if;

  update public.community_member_code_settings
  set prefix      = v_prefix,
      padding     = coalesce(p_padding, padding),
      next_number = coalesce(p_starting_number, next_number)
  where community_id = p_community_id;

  perform app.write_audit_log(
    p_community_id, 'officer', auth.uid(), 'community.update_member_codes', 'community', p_community_id,
    v_before, (select to_jsonb(s) from public.community_member_code_settings s where s.community_id = p_community_id)
  );
end;
$$;

comment on function app.update_member_code_settings is
  'community.edit_profile. Changing the prefix affects codes issued afterwards — existing member codes are never rewritten, because other people already hold them.';


-- ── Community configuration: the member profile schema ───────────────────────
create or replace function app.upsert_member_attribute_definition(
  p_community_id          uuid,
  p_key                   text,
  p_label                 text,
  p_type                  public.member_attribute_type,
  p_options               text[] default null,
  p_required_at_join      boolean default false,
  p_is_unique             boolean default false,
  p_is_primary_identifier boolean default false,
  p_sort_order            smallint default 0,
  p_definition_id         uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id       uuid;
  v_existing public.member_attribute_definitions%rowtype;
  v_key      text := lower(trim(coalesce(p_key, '')));
begin
  perform app.require_permission(p_community_id, 'community.edit_profile');

  if v_key !~ '^[a-z][a-z0-9_]{0,38}$' then
    raise exception 'INVALID_FIELD_KEY: "%" must start with a letter and use only lowercase letters, numbers and underscores', v_key
      using errcode = 'P0001';
  end if;
  if char_length(coalesce(trim(p_label), '')) not between 1 and 40 then
    raise exception 'INVALID_FIELD_LABEL: a field label is 1 to 40 characters' using errcode = 'P0001';
  end if;
  if p_type = 'single_select' and coalesce(array_length(p_options, 1), 0) = 0 then
    raise exception 'INVALID_FIELD_OPTIONS: a choice field needs at least one option' using errcode = 'P0001';
  end if;
  if p_is_primary_identifier and not p_is_unique then
    raise exception 'INVALID_FIELD_CONFIGURATION: a primary identifier must be unique — it is what tells two members apart'
      using errcode = 'P0001';
  end if;

  if p_definition_id is null then
    -- The unique index on (community_id, key) would catch this, with a message
    -- written for a DBA. An organiser adding "Level" twice should be told that,
    -- in those words.
    if exists (
      select 1 from public.member_attribute_definitions
      where community_id = p_community_id and key = v_key
    ) then
      raise exception 'FIELD_EXISTS: this community already has a field called "%"', v_key
        using errcode = 'P0001',
              hint = 'Edit the existing field instead of adding a second one with the same key.';
    end if;
  else
    select * into v_existing
    from public.member_attribute_definitions
    where id = p_definition_id and community_id = p_community_id;

    if v_existing.id is null then
      raise exception 'NOT_FOUND: field % does not belong to this community', p_definition_id using errcode = 'P0002';
    end if;

    -- The key identifies every value already stored against this field. Renaming
    -- the label is presentation; renaming the key would orphan the data.
    if v_key <> v_existing.key then
      raise exception 'FIELD_KEY_IS_FIXED: the field key cannot change once it exists — it is what the stored answers are filed under'
        using errcode = 'P0001',
              hint = 'Change the label instead, or add a new field and move the values deliberately.';
    end if;
  end if;

  -- Only one primary identifier per community, and switching it is a deliberate
  -- act rather than a second row quietly winning the partial unique index.
  if p_is_primary_identifier then
    update public.member_attribute_definitions
    set is_primary_identifier = false
    where community_id = p_community_id
      and is_primary_identifier
      and (p_definition_id is null or id <> p_definition_id);
  end if;

  insert into public.member_attribute_definitions as d (
    id, community_id, key, label, type, options, required_at_join,
    is_unique, is_primary_identifier, sort_order
  ) values (
    coalesce(p_definition_id, app.uuid_generate_v7()), p_community_id, v_key, trim(p_label), p_type,
    case when p_type = 'single_select' then p_options else null end,
    coalesce(p_required_at_join, false), coalesce(p_is_unique, false),
    coalesce(p_is_primary_identifier, false), coalesce(p_sort_order, 0)
  )
  on conflict (id) do update
    set label                 = excluded.label,
        type                  = excluded.type,
        options               = excluded.options,
        required_at_join      = excluded.required_at_join,
        is_unique             = excluded.is_unique,
        is_primary_identifier = excluded.is_primary_identifier,
        sort_order            = excluded.sort_order
  returning d.id into v_id;

  perform app.write_audit_log(
    p_community_id, 'officer', auth.uid(),
    case when p_definition_id is null then 'member_field.create' else 'member_field.update' end,
    'member_field', v_id,
    case when v_existing.id is null then null else to_jsonb(v_existing) end,
    (select to_jsonb(d) from public.member_attribute_definitions d where d.id = v_id)
  );

  return v_id;
end;
$$;

comment on function app.upsert_member_attribute_definition is
  'community.edit_profile. Defines one community member field. The key is immutable once created — it is what stored answers are filed under (the same rule collection_fields follows).';

create or replace function app.delete_member_attribute_definition(p_definition_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_definition public.member_attribute_definitions%rowtype;
  v_value_count integer;
begin
  select * into v_definition from public.member_attribute_definitions where id = p_definition_id;
  if v_definition.id is null then
    raise exception 'NOT_FOUND: field % does not exist', p_definition_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_definition.community_id, 'community.edit_profile');

  select count(*) into v_value_count
  from public.member_attribute_values where definition_id = p_definition_id;

  -- Deleting the definition cascades to every stored answer. That is a real
  -- loss of member data, so it is audited with the count before it happens and
  -- the caller is told what it costs.
  perform app.write_audit_log(
    v_definition.community_id, 'officer', auth.uid(), 'member_field.delete', 'member_field', p_definition_id,
    to_jsonb(v_definition), jsonb_build_object('values_removed', v_value_count)
  );

  delete from public.member_attribute_definitions where id = p_definition_id;
end;
$$;

comment on function app.delete_member_attribute_definition(uuid) is
  'community.edit_profile. Removes a member field and every answer stored against it, audited with the number of answers lost.';


-- ── redeem_invite_link, replaced ─────────────────────────────────────────────
-- Unchanged in shape and in every rule it already enforced (MEM-05, MEM-09,
-- SEC-20b). What changes: a member who joins through a link now receives a
-- community member code like every other member, so §16 holds on the one path
-- where the member creates themselves.
--
-- Per-link field requirements and attribute capture are Milestone 4; this keeps
-- the signature so nothing above it has to change twice.
create or replace function app.redeem_invite_link(
  p_token      text,
  p_full_name  text,
  p_phone_e164 text,
  p_email      extensions.citext default null,
  p_group_ids  uuid[] default '{}'
)
returns table (member_id uuid, status public.member_status)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link      public.invite_links%rowtype;
  v_phone     text := app.normalise_phone(p_phone_e164);
  v_status    public.member_status;
  v_member_id uuid;
  v_group_id  uuid;
begin
  if v_phone is null then
    raise exception 'INVALID_PHONE: % is not a recognisable phone number', p_phone_e164 using errcode = 'P0001';
  end if;
  if char_length(coalesce(p_full_name, '')) < 1 or char_length(p_full_name) > 120 then
    raise exception 'INVALID_NAME: name must be 1 to 120 characters' using errcode = 'P0001';
  end if;

  select * into v_link
  from public.invite_links
  where token_prefix = left(p_token, 12)
  limit 1;

  if v_link.id is null or v_link.token_hash <> encode(extensions.digest(p_token, 'sha256'), 'hex') then
    raise exception 'INVITE_NOT_FOUND: this invite link is not valid' using errcode = 'P0002';
  end if;
  if v_link.status = 'revoked' then
    raise exception 'INVITE_REVOKED: this invite link has been revoked' using errcode = 'P0001';
  end if;
  if v_link.expires_at is not null and v_link.expires_at <= now() then
    raise exception 'INVITE_EXPIRED: this invite link has expired' using errcode = 'P0001';
  end if;
  if v_link.max_uses is not null and v_link.uses >= v_link.max_uses then
    raise exception 'INVITE_EXHAUSTED: this invite link has reached its usage limit' using errcode = 'P0001';
  end if;
  if v_link.status <> 'active' then
    raise exception 'INVITE_UNAVAILABLE: this invite link is no longer active' using errcode = 'P0001';
  end if;

  -- 'active' requires phone verification this endpoint does not perform
  -- (CON-22 is a separate OTP challenge); 'unclaimed' is the closest honest
  -- status for "on the roll, not yet confirmed" (comment on public.members).
  v_status := case when v_link.approve_joiners then 'pending_approval' else 'unclaimed' end;
  v_member_id := app.uuid_generate_v7();

  -- The ONE change from the Phase 2 body: a joiner receives a community member
  -- code like every other member (§16). Everything else here — the validation
  -- order, the error codes, the group rules, the usage accounting, the audit
  -- action — is Phase 2's, unchanged, because 07_application_write_functions.sql
  -- asserts it and because none of it was wrong.
  insert into public.members (
    id, community_id, full_name, phone_e164, email, member_code, status, joined_via,
    invite_link_id, created_by
  ) values (
    v_member_id, v_link.community_id, p_full_name, v_phone, p_email,
    app.next_member_code(v_link.community_id),
    v_status, 'invite_link', v_link.id, null
  );

  foreach v_group_id in array coalesce(v_link.group_ids, '{}')
  loop
    insert into public.member_group_memberships (member_id, group_id)
    values (v_member_id, v_group_id);
  end loop;

  if v_link.allow_group_choice then
    foreach v_group_id in array coalesce(p_group_ids, '{}')
    loop
      insert into public.member_group_memberships (member_id, group_id)
      select v_member_id, id
      from public.member_groups
      where id = v_group_id and community_id = v_link.community_id and pickable_at_join
      on conflict do nothing;

      exit when not v_link.allow_multi_group;
    end loop;
  end if;

  -- Table-qualified: `status` is also the name of this function's second OUT
  -- parameter (returns table (member_id uuid, status ...)), which PL/pgSQL
  -- exposes as a variable, so the bare column name is ambiguous by default.
  update public.invite_links
  set uses = invite_links.uses + 1,
      status = case when invite_links.max_uses is not null and invite_links.uses + 1 >= invite_links.max_uses
                     then 'exhausted'::public.invite_status
                     else invite_links.status end
  where id = v_link.id;

  perform app.write_audit_log(
    v_link.community_id, 'member', null, 'member.join_via_invite', 'member', v_member_id
  );

  return query select v_member_id, v_status;
end;
$$;

comment on function app.redeem_invite_link is
  'MEM-05, anonymous. Joins the community as an unconfirmed member and issues their community member code. Never marks a member ''active'' — that status means phone-verified (CON-22), which this endpoint does not perform.';

revoke all on function app.next_member_code(uuid)              from public;
revoke all on function app.set_member_attributes(uuid, jsonb)  from public;
-- The rest are granted by name in 20260920120200.
