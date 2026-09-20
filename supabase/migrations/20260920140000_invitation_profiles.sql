-- ─────────────────────────────────────────────────────────────────────────────
-- 20260920140000 — Invitations that know the community's member profile
--
-- An invite link already carried who may join and where they land (MEM-05,
-- MEM-04: group_ids, allow_group_choice, approve_joiners). What it could not
-- say is what to ASK them. The join form collected a name, a phone and an
-- email, which is the same form for a university association and an estate —
-- so a school still had to chase every joiner afterwards for their matric
-- number.
--
-- Now the community's own member fields (20260920120000) are part of the
-- invitation: the link names which of them the form shows and which of those
-- are required, and the answers are stored against the same definitions an
-- officer would have used.
--
-- THE SECURITY SHAPE, because this is the one anonymous write path in the
-- schema (MEM-05). The link decides everything that grants anything:
--
--   · which groups the joiner lands in — the browser may propose only from the
--     groups the link itself allows, and a proposal outside that set is ignored
--     rather than honoured
--   · which fields are asked and which are required — a joiner cannot skip a
--     required field by omitting it from the payload, and cannot write a value
--     for a field the link never asked for
--   · no role, ever. A member invite creates a member. Officer roles come from
--     officer_invitations (OFF-01), which is a different table, a different
--     function, and requires a signed-in invitee.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.invite_links
  add column asked_attribute_keys    text[] not null default '{}',
  add column required_attribute_keys text[] not null default '{}';

comment on column public.invite_links.asked_attribute_keys is
  'Which of the community''s member fields this link''s form shows. Keys reference member_attribute_definitions.key.';
comment on column public.invite_links.required_attribute_keys is
  'The subset of asked_attribute_keys a joiner must answer. Enforced by app.redeem_invite_link, not by the form.';

-- Required has to be a subset of asked, or the form would demand an answer to a
-- question it never asked.
alter table public.invite_links
  add constraint invite_links_required_within_asked
  check (required_attribute_keys <@ asked_attribute_keys);


-- ── create_invite_link, replaced to carry the field selection ───────────────
drop function if exists app.create_invite_link(uuid, uuid[], boolean, boolean, boolean, timestamptz, integer, text);

create or replace function app.create_invite_link(
  p_community_id            uuid,
  p_group_ids               uuid[] default '{}',
  p_allow_group_choice      boolean default false,
  p_allow_multi_group       boolean default false,
  p_approve_joiners         boolean default false,
  p_expires_at              timestamptz default null,
  p_max_uses                integer default null,
  p_label                   text default null,
  p_asked_attribute_keys    text[] default '{}',
  p_required_attribute_keys text[] default '{}'
)
returns table (id uuid, token text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token   record;
  v_link_id uuid;
  v_key     text;
  v_groups  uuid[];
begin
  perform app.require_permission(p_community_id, 'invite.create');

  -- A group id from another community is not an error to report — reporting it
  -- would confirm the id exists — it simply does not survive the filter.
  select coalesce(array_agg(g.id), '{}')
    into v_groups
  from public.member_groups g
  where g.id = any (coalesce(p_group_ids, '{}'))
    and g.community_id = p_community_id
    and g.archived_at is null;

  foreach v_key in array coalesce(p_asked_attribute_keys, '{}')
  loop
    if not exists (
      select 1 from public.member_attribute_definitions
      where community_id = p_community_id and key = v_key
    ) then
      raise exception 'UNKNOWN_MEMBER_FIELD: this community has no member field called "%"', v_key
        using errcode = 'P0001';
    end if;
  end loop;

  if not (coalesce(p_required_attribute_keys, '{}') <@ coalesce(p_asked_attribute_keys, '{}')) then
    raise exception 'INVALID_INVITE_FIELDS: a field cannot be required unless the form asks for it'
      using errcode = 'P0001';
  end if;

  select * into v_token from app.generate_secret_token();
  v_link_id := app.uuid_generate_v7();

  insert into public.invite_links (
    id, community_id, token_prefix, token_hash, group_ids,
    allow_group_choice, allow_multi_group, approve_joiners,
    expires_at, max_uses, label, asked_attribute_keys, required_attribute_keys, created_by
  ) values (
    v_link_id, p_community_id, v_token.token_prefix, v_token.token_hash, v_groups,
    coalesce(p_allow_group_choice, false), coalesce(p_allow_multi_group, false),
    coalesce(p_approve_joiners, false), p_expires_at, p_max_uses, p_label,
    coalesce(p_asked_attribute_keys, '{}'), coalesce(p_required_attribute_keys, '{}'), auth.uid()
  );

  perform app.write_audit_log(
    p_community_id, 'officer', auth.uid(), 'invite.create', 'invite_link', v_link_id,
    null, jsonb_build_object('groups', array_length(v_groups, 1), 'label', p_label)
  );

  return query select v_link_id, v_token.token;
end;
$$;

comment on function app.create_invite_link is
  'MEM-05 / MEM-04. SEC-20b: the raw token is returned exactly once and never stored. The link carries which groups a joiner lands in and which member fields the form asks — both decided here, by someone holding invite.create, not by the person joining.';


-- ── The public face of an invitation ────────────────────────────────────────
-- Everything the join page needs and nothing more: the community it belongs to,
-- whether the link still works, which groups the joiner will land in (by name,
-- so the page can say "you are joining 300 Level"), and the fields to ask.
--
-- Deliberately absent: member counts, other members, officer names, the token
-- hash, who created the link, how many times it has been used. An invitation
-- page is not a window into the community.
create or replace function app.get_public_invite(p_token text)
returns table (
  community_name    text,
  community_logo_url text,
  label             text,
  approve_joiners   boolean,
  allow_group_choice boolean,
  allow_multi_group boolean,
  preset_group_names text[],
  fields            jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_link public.invite_links%rowtype;
begin
  select * into v_link
  from public.invite_links
  where token_prefix = left(p_token, 12)
  limit 1;

  -- A wrong token and an expired one are told apart by the redeem function,
  -- which the person reaches by submitting. This read simply returns nothing,
  -- so a scraper learns only that some token did not resolve.
  if v_link.id is null
     or v_link.token_hash <> encode(extensions.digest(p_token, 'sha256'), 'hex')
     or v_link.status <> 'active'
     or (v_link.expires_at is not null and v_link.expires_at <= now())
     or (v_link.max_uses is not null and v_link.uses >= v_link.max_uses) then
    return;
  end if;

  return query
  select
    c.name,
    c.logo_url,
    v_link.label,
    v_link.approve_joiners,
    v_link.allow_group_choice,
    v_link.allow_multi_group,
    coalesce(
      (select array_agg(g.name order by g.sort_order)
       from public.member_groups g
       where g.id = any (v_link.group_ids)),
      '{}'
    ),
    coalesce(
      (select jsonb_agg(
                jsonb_build_object(
                  'key', d.key,
                  'label', d.label,
                  'type', d.type,
                  'options', d.options,
                  'required', d.key = any (v_link.required_attribute_keys)
                )
                order by d.sort_order
              )
       from public.member_attribute_definitions d
       where d.community_id = v_link.community_id
         and d.key = any (v_link.asked_attribute_keys)),
      '[]'::jsonb
    )
  from public.communities c
  where c.id = v_link.community_id
    and c.status = 'active';
end;
$$;

comment on function app.get_public_invite(text) is
  'SEC-12-style whitelist for the join page: the community, the groups the joiner will land in, and the fields to ask. Never member data, never the token, never how the link has been used.';


-- ── redeem_invite_link, replaced to capture the answers ─────────────────────
drop function if exists app.redeem_invite_link(text, text, text, extensions.citext, uuid[]);

create or replace function app.redeem_invite_link(
  p_token      text,
  p_full_name  text,
  p_phone_e164 text,
  p_email      extensions.citext default null,
  p_group_ids  uuid[] default '{}',
  p_attributes jsonb default '{}'::jsonb
)
returns table (member_id uuid, status public.member_status, member_code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link      public.invite_links%rowtype;
  v_phone     text := app.normalise_phone(p_phone_e164);
  v_status    public.member_status;
  v_member_id uuid;
  v_code      text;
  v_group_id  uuid;
  v_key       text;
  v_filtered  jsonb := '{}'::jsonb;
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

  -- Only what the link asked for survives. A value for a field the invitation
  -- never mentioned is dropped rather than stored: the joiner does not get to
  -- choose which of the community's fields they fill in.
  foreach v_key in array coalesce(v_link.asked_attribute_keys, '{}')
  loop
    if nullif(trim(coalesce(p_attributes ->> v_key, '')), '') is not null then
      v_filtered := v_filtered || jsonb_build_object(v_key, p_attributes ->> v_key);
    end if;
  end loop;

  foreach v_key in array coalesce(v_link.required_attribute_keys, '{}')
  loop
    if v_filtered ->> v_key is null then
      raise exception 'MISSING_REQUIRED_FIELD: %s is required to join',
        (select label from public.member_attribute_definitions
         where community_id = v_link.community_id and key = v_key)
        using errcode = 'P0001';
    end if;
  end loop;

  -- 'active' requires phone verification this endpoint does not perform
  -- (CON-22 is a separate OTP challenge); 'unclaimed' is the closest honest
  -- status for "on the roll, not yet confirmed".
  v_status := case when v_link.approve_joiners then 'pending_approval' else 'unclaimed' end;
  v_member_id := app.uuid_generate_v7();
  v_code := app.next_member_code(v_link.community_id);

  insert into public.members (
    id, community_id, full_name, phone_e164, email, member_code, status, joined_via,
    invite_link_id, created_by
  ) values (
    v_member_id, v_link.community_id, p_full_name, v_phone, p_email, v_code,
    v_status, 'invite_link', v_link.id, null
  );

  perform app.set_member_attributes(v_member_id, v_filtered);

  foreach v_group_id in array coalesce(v_link.group_ids, '{}')
  loop
    insert into public.member_group_memberships (member_id, group_id)
    values (v_member_id, v_group_id)
    on conflict do nothing;
  end loop;

  if v_link.allow_group_choice then
    foreach v_group_id in array coalesce(p_group_ids, '{}')
    loop
      insert into public.member_group_memberships (member_id, group_id)
      select v_member_id, id
      from public.member_groups
      where id = v_group_id
        and community_id = v_link.community_id
        and pickable_at_join
        and archived_at is null
      on conflict do nothing;

      exit when not v_link.allow_multi_group;
    end loop;
  end if;

  -- Table-qualified: `status` is also an OUT parameter name, which PL/pgSQL
  -- exposes as a variable, so the bare column name would be ambiguous.
  update public.invite_links
  set uses = invite_links.uses + 1,
      status = case when invite_links.max_uses is not null and invite_links.uses + 1 >= invite_links.max_uses
                     then 'exhausted'::public.invite_status
                     else invite_links.status end
  where id = v_link.id;

  perform app.write_audit_log(
    v_link.community_id, 'member', null, 'member.join_via_invite', 'member', v_member_id,
    null, jsonb_build_object('member_code', v_code)
  );

  return query select v_member_id, v_status, v_code;
end;
$$;

comment on function app.redeem_invite_link is
  'MEM-05, anonymous. The link decides the groups and the fields; the joiner supplies answers. Returns the community member code so the person sees who they now are (§16). Never grants a role — officer roles come from officer_invitations.';
