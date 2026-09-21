-- ─────────────────────────────────────────────────────────────────────────────
-- 20260921180100 — Issuing a contributor reference
--
-- Part J, point by point:
--
--   unique within scope      unique (collection_id, reference), in the database
--   stable                   nothing updates it; a trigger says so
--   immutable after issuance  same trigger
--   generated server-side    these functions; no client writes the table
--   collision-safe           the counter is a locked row, and the unique index
--                            catches it anyway
--   concurrency-safe         UPDATE … RETURNING serialises two callers
--   non-guessable where it matters  the `random` style
--   never generated in the browser  nothing is granted that would let it
--
-- The retry loop deserves a note. When an insert loses to the unique index —
-- which can only happen if a reference was created some other way, for
-- instance by a migration carrying old codes forward — the number that was
-- spent is NOT returned to the counter. That is deliberate. A counter that
-- gave numbers back would eventually hand out one that is already printed on
-- somebody's ticket, which is the exact failure CODE-04 exists to prevent.
-- Numbers are cheap; collisions are not.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── The format, in one place ────────────────────────────────────────────────
-- Both the issuing function and the settings screen's live example have to
-- agree about what "BIO26-0001" looks like, so neither of them owns the rule.
create or replace function app.build_contributor_reference(
  p_prefix    text,
  p_separator text,
  p_digits    smallint,
  p_number    bigint
)
returns text
language sql
immutable
set search_path = ''
as $$
  -- `lpad` TRUNCATES from the left when the string is already longer than the
  -- width — lpad('12345', 4, '0') is '1234'. On a reference that is a
  -- collision waiting to happen: the ten-thousandth member of a four-digit
  -- collection would be handed 1234, which the thousand-two-hundred-and-
  -- thirty-fourth already holds. So the padding is applied only when it
  -- actually pads, and a number past the width simply gets longer.
  select p_prefix || coalesce(p_separator, '-') ||
         case
           when char_length(p_number::text) >= p_digits::int then p_number::text
           else lpad(p_number::text, p_digits::int, '0')
         end;
$$;

comment on function app.build_contributor_reference(text, text, smallint, bigint) is
  'M7.6: prefix + separator + zero-padded number. Immutable and pure so the settings screen''s example and the issued reference cannot disagree.';


-- ── The counter ─────────────────────────────────────────────────────────────
create or replace function app.next_collection_code_number(
  p_collection_id uuid,
  p_tier_id       uuid,
  p_seed          bigint
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_number bigint;
begin
  -- Take the number and move the counter on, in one statement. The row lock
  -- this takes is the whole concurrency story: a second caller blocks here
  -- until the first commits, and then reads the moved value rather than the
  -- one it would have read a moment ago.
  update public.collection_code_sequences
  set next_number = next_number + 1
  where collection_id = p_collection_id
    and tier_id is not distinct from p_tier_id
  returning next_number - 1 into v_number;

  if v_number is not null then
    return v_number;
  end if;

  -- First reference in this scope. Seed the counter, letting a concurrent
  -- caller win the race, then take a number the same way as everybody else.
  insert into public.collection_code_sequences (collection_id, tier_id, next_number)
  values (p_collection_id, p_tier_id, greatest(p_seed, 1))
  on conflict (collection_id, tier_id) do nothing;

  update public.collection_code_sequences
  set next_number = next_number + 1
  where collection_id = p_collection_id
    and tier_id is not distinct from p_tier_id
  returning next_number - 1 into v_number;

  return v_number;
end;
$$;

comment on function app.next_collection_code_number(uuid, uuid, bigint) is
  'M7.6 part AB: hands out the next number in a scope and moves the counter, under the row lock that UPDATE takes. Never `count(*) + 1`, which two concurrent callers read identically and a deletion makes wrong.';


-- ── Issuing ─────────────────────────────────────────────────────────────────
create or replace function app.issue_contributor_reference(p_obligation_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_obligation  public.obligations%rowtype;
  v_collection  public.collections%rowtype;
  v_settings    public.collection_code_settings%rowtype;
  v_existing    text;
  v_tier_prefix text;
  v_scope_tier  uuid;
  v_prefix      text;
  v_seed        bigint;
  v_number      bigint;
  v_reference   text;
  v_attempt     integer;
begin
  select * into v_obligation from public.obligations where id = p_obligation_id;
  if v_obligation.id is null then
    raise exception 'NOT_FOUND: that record does not exist' using errcode = 'P0002';
  end if;

  -- Tenancy from the row, never from the caller (SEC-18). Issuing a reference
  -- is an act on the roll, so it is the roll's permission.
  perform app.require_permission(v_obligation.community_id, 'obligation.assign');

  -- Already has one. Idempotent by design: a double submit, a retried request
  -- and a second officer pressing the same button all get the same answer.
  select reference into v_existing
  from public.contributor_references
  where obligation_id = p_obligation_id;
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_collection from public.collections where id = v_obligation.collection_id;
  if not v_collection.codes_enabled then
    raise exception 'CODES_NOT_ENABLED: this collection does not issue contributor references'
      using errcode = 'P0001',
            hint = 'Turn on contributor references in the collection''s settings first.';
  end if;

  select * into v_settings
  from public.collection_code_settings
  where collection_id = v_obligation.collection_id;

  -- Part K: a tier with its own prefix numbers separately, so REG-0001 and
  -- VIP-0001 can both exist in one collection. A tier WITHOUT a prefix falls
  -- back to the collection's own sequence rather than inventing one.
  if v_obligation.tier_id is not null then
    select code_prefix into v_tier_prefix
    from public.collection_tiers
    where id = v_obligation.tier_id;
  end if;

  if v_tier_prefix is not null then
    v_prefix     := v_tier_prefix;
    v_scope_tier := v_obligation.tier_id;
  else
    v_prefix     := v_settings.prefix;
    v_scope_tier := null;
  end if;

  if v_prefix is null or v_prefix = '' then
    raise exception 'NO_PREFIX: this collection has no reference prefix set'
      using errcode = 'P0001',
            hint = 'A reference without a prefix is just a number, and a number is not recognisable on a receipt. Set one in the collection''s settings.';
  end if;

  -- Where this scope starts counting. `next_number` is the value the
  -- migration pipeline carries forward from the old system; `start_number` is
  -- what the organiser chose. The higher of the two is the only safe floor.
  v_seed := greatest(coalesce(v_settings.next_number, 1), coalesce(v_settings.start_number, 1));

  for v_attempt in 1..10 loop
    if v_settings.style = 'random' then
      -- Crockford-ish: no I, L, O, U, so nothing is misread off a printed
      -- ticket or misheard over a phone.
      v_number := null;
      v_reference := v_prefix || coalesce(v_settings.separator, '-') || (
        select string_agg(substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',
                                 1 + floor(random() * 32)::int, 1), '')
        from generate_series(1, 6)
      );
    else
      v_number := app.next_collection_code_number(
        v_obligation.collection_id, v_scope_tier, v_seed
      );
      v_reference := app.build_contributor_reference(
        v_prefix, coalesce(v_settings.separator, '-'), coalesce(v_settings.digits, 4::smallint), v_number
      );
    end if;

    -- The counter is taken OUTSIDE this block on purpose: a rollback of the
    -- insert must not give the number back (see the header).
    begin
      insert into public.contributor_references (
        community_id, collection_id, obligation_id, tier_id,
        reference, sequence_number, issued_by
      ) values (
        v_obligation.community_id, v_obligation.collection_id, p_obligation_id, v_obligation.tier_id,
        v_reference, v_number, auth.uid()
      );

      perform app.write_audit_log(
        v_obligation.community_id, 'officer', auth.uid(),
        'collection.reference_issued', 'obligation', p_obligation_id,
        null,
        jsonb_build_object(
          'collection_id', v_obligation.collection_id,
          'reference', v_reference,
          'tier_id', v_obligation.tier_id
        )
      );

      return v_reference;
    exception
      when unique_violation then
        -- Somebody or something already holds that reference. Take the next
        -- one. The index did its job.
        null;
    end;
  end loop;

  raise exception 'REFERENCE_NOT_ISSUED: could not find a free reference after 10 attempts'
    using errcode = 'P0001',
          hint = 'This usually means the prefix is shared with codes carried over from an older system. Change the prefix or the starting number.';
end;
$$;

comment on function app.issue_contributor_reference(uuid) is
  'M7.6: issues (or returns) the reference for one participation. Idempotent, server-side, audited, and guarded by a unique index rather than by hope.';


-- ── Issuing for everybody who has not got one ───────────────────────────────
-- Ordered oldest first so the numbers follow the order people were added,
-- which is the order the organiser expects to read them in.
create or replace function app.issue_contributor_references_for_collection(p_collection_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
  v_obligation_id uuid;
  v_issued integer := 0;
begin
  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_collection.community_id, 'obligation.assign');

  for v_obligation_id in
    select o.id
    from public.obligations o
    left join public.contributor_references r on r.obligation_id = o.id
    where o.collection_id = p_collection_id
      and o.status <> 'cancelled'
      and r.id is null
    order by o.created_at, o.id
  loop
    perform app.issue_contributor_reference(v_obligation_id);
    v_issued := v_issued + 1;
  end loop;

  return v_issued;
end;
$$;

comment on function app.issue_contributor_references_for_collection(uuid) is
  'M7.6: gives a reference to everyone on the roll who has not got one. Skips cancelled rows, and skips anyone who already has one rather than reissuing.';


-- ── Configuring the format ──────────────────────────────────────────────────
create or replace function app.set_collection_code_settings(
  p_collection_id uuid,
  p_enabled       boolean,
  p_prefix        text,
  p_separator     text,
  p_digits        smallint,
  p_start_number  bigint,
  p_style         public.code_style
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
  v_issued     integer;
  v_before     jsonb;
begin
  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_collection.community_id, 'collection.configure_codes');

  select count(*) into v_issued
  from public.contributor_references
  where collection_id = p_collection_id;

  select to_jsonb(s) into v_before
  from public.collection_code_settings s
  where s.collection_id = p_collection_id;

  -- Once a reference has been issued the format is history. Changing it now
  -- would leave BIO26-0001 and DIN-0002 in the same series, and the person
  -- holding the first one would have no way to know which is current.
  if v_issued > 0 and exists (
    select 1 from public.collection_code_settings s
    where s.collection_id = p_collection_id
      and (s.prefix     is distinct from p_prefix
        or s.separator  is distinct from coalesce(p_separator, '-')
        or s.digits     is distinct from coalesce(p_digits, 4::smallint)
        or s.style      is distinct from coalesce(p_style, 'sequential'::public.code_style))
  ) then
    raise exception 'REFERENCES_ALREADY_ISSUED: % references have been issued, so the format is fixed', v_issued
      using errcode = 'P0001',
            hint = 'References already given out may be printed on tickets or receipts. You can still turn references off, which stops new ones being issued.';
  end if;

  insert into public.collection_code_settings (
    collection_id, community_id, prefix, style, separator, digits, start_number
  ) values (
    p_collection_id, v_collection.community_id, p_prefix,
    coalesce(p_style, 'sequential'::public.code_style),
    coalesce(p_separator, '-'), coalesce(p_digits, 4::smallint), greatest(coalesce(p_start_number, 1), 1)
  )
  on conflict (collection_id) do update
  set prefix       = excluded.prefix,
      style        = excluded.style,
      separator    = excluded.separator,
      digits       = excluded.digits,
      start_number = excluded.start_number;

  update public.collections
  set codes_enabled = p_enabled
  where id = p_collection_id;

  perform app.write_audit_log(
    v_collection.community_id, 'officer', auth.uid(),
    'collection.code_settings_updated', 'collection', p_collection_id,
    v_before,
    jsonb_build_object(
      'codes_enabled', p_enabled, 'prefix', p_prefix, 'separator', coalesce(p_separator, '-'),
      'digits', coalesce(p_digits, 4::smallint), 'start_number', greatest(coalesce(p_start_number, 1), 1),
      'style', coalesce(p_style, 'sequential'::public.code_style)
    )
  );
end;
$$;

comment on function app.set_collection_code_settings(uuid, boolean, text, text, smallint, bigint, public.code_style) is
  'M7.6 part I. collection.configure_codes (owner, admin). Refuses to change the format once references have been issued, because those are already on paper somewhere.';


-- ── An export is a disclosure, and disclosures are recorded (part Z) ────────
create or replace function app.record_collection_export(
  p_collection_id uuid,
  p_subject       text,
  p_format        text,
  p_row_count     integer,
  p_fields        text[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
begin
  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_collection.community_id, 'member.export');

  perform app.write_audit_log(
    v_collection.community_id, 'officer', auth.uid(),
    'collection.export_created', 'collection', p_collection_id,
    null,
    jsonb_build_object(
      'subject', p_subject,
      'format', p_format,
      'row_count', p_row_count,
      -- The COLUMN NAMES, which is the disclosure worth recording. No value
      -- from any row is logged: an audit trail of an export must not become a
      -- second copy of the personal data it is auditing (SEC-26).
      'fields', to_jsonb(p_fields)
    )
  );
end;
$$;

comment on function app.record_collection_export(uuid, text, text, integer, text[]) is
  'M7.6 part Z: records that member data left the system — who, which collection, which columns, how many rows, what format. Never the values.';


revoke execute on function app.build_contributor_reference(text, text, smallint, bigint)            from public;
revoke execute on function app.next_collection_code_number(uuid, uuid, bigint)                      from public;
revoke execute on function app.issue_contributor_reference(uuid)                                     from public;
revoke execute on function app.issue_contributor_references_for_collection(uuid)                     from public;
revoke execute on function app.set_collection_code_settings(uuid, boolean, text, text, smallint, bigint, public.code_style) from public;
revoke execute on function app.record_collection_export(uuid, text, text, integer, text[])           from public;

-- The counter is plumbing. Nothing outside the issuing function may move it,
-- or a number could be spent without a reference to show for it.
grant execute on function app.issue_contributor_reference(uuid)                 to authenticated;
grant execute on function app.issue_contributor_references_for_collection(uuid) to authenticated;
grant execute on function app.set_collection_code_settings(uuid, boolean, text, text, smallint, bigint, public.code_style) to authenticated;
grant execute on function app.record_collection_export(uuid, text, text, integer, text[])            to authenticated;
grant execute on function app.build_contributor_reference(text, text, smallint, bigint)              to authenticated;
