-- ─────────────────────────────────────────────────────────────────────────────
-- 20260928100000 — Email comparisons name citext's operator explicitly (F-2)
--
-- Finding F-2, docs/migration/STAGING-ENVIRONMENT-VALIDATION.md §13.
--
-- THE DEFECT. Email columns are `extensions.citext`, and citext is
-- case-insensitive only when *its* `=` is the operator Postgres picks. Postgres
-- picks by search path, at the moment an expression is parsed. Where the
-- `extensions` schema is not on that path, `citext = citext` does not fail — it
-- silently resolves to `text = text`, which is case-sensitive. No error, no
-- warning.
--
-- Two places were parsed that way:
--
--   · Functions declared `set search_path = ''` — every environment, every call.
--     app.assert_is_invitee   → an invitation addressed to Ada.Case@Example.test
--                               could be SEEN by ada.case@example.test and then
--                               refused on ACCEPT.
--     app.find_member_duplicates → duplicate detection missed case variants, so
--                               the same person could be added twice.
--
--   · The RLS policy officer_invitations_select_invitee, on the hosted staging
--     project. The CLI pushes migrations as `cli_login_postgres`, which has no
--     search_path setting, so the policy was stored with `text =`. Locally the
--     push role is `postgres`, whose path includes `extensions`, so local was
--     correct — the two environments disagreed without either reporting it.
--
-- THE FIX. Every one of these comparisons now writes `operator(extensions.=)`.
-- A schema-qualified operator is resolved by name, not by search path, so the
-- result is the same whichever role parses it and whatever that role's path is.
-- That is the requirement: deterministic, explicit, independent of ambient
-- configuration.
--
-- WHAT THIS DOES NOT DO.
--   · It does not lowercase or otherwise rewrite any stored email. citext stores
--     what was typed; the comparison is what was wrong, so the comparison is
--     what changes.
--   · It does not change who can call anything, or what any function checks
--     before comparing. Every authorisation step — app.require_permission, the
--     auth.uid() match, the status and expiry conditions — is carried over
--     unchanged. Only the equality operator on the email line differs.
--   · It does not edit 20260917121000_rls_policies.sql or any applied migration.
--
-- Covered by supabase/tests/24_email_case_insensitivity.sql.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. The invitee's view of their own invitation ────────────────────────────
-- ALTER, not DROP/CREATE: the policy keeps its name, command (SELECT) and role
-- (authenticated); only the USING expression is re-parsed. Identical to
-- 20260917121000 except the email equality.
alter policy officer_invitations_select_invitee
  on public.officer_invitations
  using (
    status = 'sent'
    and expires_at > now()
    and exists (
      select 1 from public.users u
      where u.id = (select auth.uid())
        and (
          (officer_invitations.invitee_email is not null
             and u.email operator(extensions.=) officer_invitations.invitee_email)
          or (officer_invitations.invitee_phone_e164 is not null
             and u.phone_e164 = officer_invitations.invitee_phone_e164)
        )
    )
  );


-- ── 2. Accept/decline: is the caller the person the invitation names? ────────
-- Unchanged from 20260918140100 except the email equality. Still SECURITY
-- INVOKER, still `search_path = ''` — the operator no longer depends on it.
create or replace function app.assert_is_invitee(p_invitation public.officer_invitations)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_matches boolean;
begin
  select exists (
    select 1 from public.users u
    where u.id = auth.uid()
      and (
        (p_invitation.invitee_email is not null
           and u.email operator(extensions.=) p_invitation.invitee_email)
        or (p_invitation.invitee_phone_e164 is not null and u.phone_e164 = p_invitation.invitee_phone_e164)
      )
  ) into v_matches;

  if not v_matches then
    raise exception 'FORBIDDEN: this invitation was not addressed to the signed-in account' using errcode = '42501';
  end if;
end;
$$;

-- Reachability, stated (sixth invariant). Unchanged in effect: only the
-- function owner could execute this before, and it is called from inside
-- app.accept_officer_invitation / app.decline_officer_invitation, never
-- directly. Stating it removes it from the invariant's grandfather list.
revoke execute on function app.assert_is_invitee(public.officer_invitations) from public, anon, authenticated;


-- ── 3. Duplicate detection ───────────────────────────────────────────────────
-- Unchanged from 20260920120100 except the email equality. Still SECURITY
-- DEFINER, still gated on app.require_permission(community, 'member.create'),
-- still scoped to the one community asked about.
create or replace function app.find_member_duplicates(
  p_community_id uuid,
  p_full_name text default null,
  p_phone_e164 text default null,
  p_email extensions.citext default null,
  p_attributes jsonb default '{}'::jsonb,
  p_exclude_member_id uuid default null
)
returns table (
  member_id uuid,
  full_name text,
  member_code text,
  status public.member_status,
  match_reason text,
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
      and m.email operator(extensions.=) p_email

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

-- Reachability, restated exactly as it stood: officers call this from the
-- member-creation screen, so `authenticated` executes it and the function's own
-- require_permission call decides which of them may. Nobody else.
revoke execute on function app.find_member_duplicates(uuid, text, text, extensions.citext, jsonb, uuid) from public, anon;
grant execute on function app.find_member_duplicates(uuid, text, text, extensions.citext, jsonb, uuid) to authenticated;
