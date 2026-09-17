-- ─────────────────────────────────────────────────────────────────────────────
-- 20260917121000 — Row-level security policies
--
-- Every policy in one file, deliberately. RLS is a single security surface and
-- reviewing it scattered across a dozen dated migrations is how the previous
-- system ended up with two tables whose policies and grants disagreed.
--
-- Three rules shape everything below.
--
-- 1. `anon` gets NO table policies at all, and no SELECT grant on any table.
--    SEC-12: anonymous access to a published collection page goes through a
--    security-definer FUNCTION returning whitelisted fields. A public page does
--    not need `SELECT *` on `collections`, and the previous system's
--    `collections_public_read` policy — which exposed every non-deleted
--    collection including drafts — is what happens when it is given one.
--
-- 2. `authenticated` gets SELECT policies only. There are NO INSERT, UPDATE or
--    DELETE policies for client roles anywhere in this schema, because there
--    are no such grants (see the grants migration). Every write goes through a
--    server function that re-checks `app.has_permission` (ADR 0008, SEC-17).
--    A policy permitting a write the grant withholds is not defence in depth;
--    it is a trap that fires the day someone adds the grant.
--
-- 3. Tenancy is always re-derived. A policy never trusts a client-supplied ID
--    to imply which community a row belongs to (SEC-18).
-- ─────────────────────────────────────────────────────────────────────────────


-- ── users ────────────────────────────────────────────────────────────────────
-- A user sees their own row and nothing else. Officer directories are served by
-- server functions that return only the fields the viewer is entitled to.
create policy users_select_self
  on public.users for select to authenticated
  using (id = (select auth.uid()));


-- ── communities ──────────────────────────────────────────────────────────────
-- Visible to anyone holding any active role in it. The `IN (SELECT ...)` form
-- lets the planner evaluate the helper once per statement rather than per row,
-- which is what keeps a multi-community dashboard fast.
create policy communities_select_officer
  on public.communities for select to authenticated
  using (id in (select app.current_user_community_ids()));

create policy community_slug_history_select_officer
  on public.community_slug_history for select to authenticated
  using (community_id in (select app.current_user_community_ids()));

create policy community_labels_select_officer
  on public.community_labels for select to authenticated
  using (community_id in (select app.current_user_community_ids()));


-- ── Roles, permissions and officer terms ─────────────────────────────────────
-- The permission catalogue and the role matrix are not secret. A user may read
-- them, which lets the UI mirror the server's rules (ROLE-03) without a
-- bespoke endpoint.
create policy permissions_select_all
  on public.permissions for select to authenticated
  using (true);

create policy role_permissions_select_all
  on public.role_permissions for select to authenticated
  using (true);

-- OFF-04 / HND-08: the Leadership history page. Anyone with dashboard access
-- sees every term, including ended ones — that is the point of the page.
create policy officer_terms_select_officer
  on public.officer_terms for select to authenticated
  using (app.has_permission(community_id, 'community.view_dashboard'));

-- A person can always see their own terms, in every community, including after
-- they end. Without this, an outgoing officer loses the record of their own
-- service the moment their term closes.
create policy officer_terms_select_self
  on public.officer_terms for select to authenticated
  using (user_id = (select auth.uid()));

create policy leadership_terms_select_officer
  on public.leadership_terms for select to authenticated
  using (app.has_permission(community_id, 'community.view_dashboard'));


-- ── Members ──────────────────────────────────────────────────────────────────
-- SEC-11: a member with a claimed record reads only rows linked to their own
-- member_id. Officers read the roll if they hold member.view_contact.
--
-- Column-level masking (SEC-24: a collector sees 0803***4521) is applied by the
-- server functions that serve member lists, not here — RLS is row-level, and
-- pretending otherwise produces policies that look like masking and are not.
create policy members_select_officer
  on public.members for select to authenticated
  using (app.has_permission(community_id, 'member.view_contact'));

create policy members_select_self
  on public.members for select to authenticated
  using (user_id = (select auth.uid()));

create policy member_attribute_definitions_select_officer
  on public.member_attribute_definitions for select to authenticated
  using (app.has_permission(community_id, 'community.view_dashboard'));

create policy member_groups_select_officer
  on public.member_groups for select to authenticated
  using (app.has_permission(community_id, 'community.view_dashboard'));

-- Group membership follows the visibility of the member it describes.
create policy member_group_memberships_select_officer
  on public.member_group_memberships for select to authenticated
  using (exists (
    select 1 from public.members m
    where m.id = member_group_memberships.member_id
      and app.has_permission(m.community_id, 'member.view_contact')
  ));

create policy member_contacts_select_officer
  on public.member_contacts for select to authenticated
  using (app.has_permission(community_id, 'member.view_contact'));


-- ── Invitations ──────────────────────────────────────────────────────────────
-- Note there is no policy exposing `token_hash` to anyone: an invite is
-- redeemed by a server function that hashes the presented token and compares.
-- Reading the row does not let you use the link, and no client ever needs to.
create policy invite_links_select_officer
  on public.invite_links for select to authenticated
  using (app.has_permission(community_id, 'invite.create'));

create policy officer_invitations_select_officer
  on public.officer_invitations for select to authenticated
  using (app.has_permission(community_id, 'officer.invite'));

-- An invitee can see the invitation addressed to them once they have signed in,
-- so the acceptance screen can show what they are accepting.
create policy officer_invitations_select_invitee
  on public.officer_invitations for select to authenticated
  using (
    status = 'sent'
    and expires_at > now()
    and exists (
      select 1 from public.users u
      where u.id = (select auth.uid())
        and (
          (officer_invitations.invitee_email is not null and u.email = officer_invitations.invitee_email)
          or (officer_invitations.invitee_phone_e164 is not null and u.phone_e164 = officer_invitations.invitee_phone_e164)
        )
    )
  );


-- ── Collections ──────────────────────────────────────────────────────────────
-- Officers see their community's collections, drafts included. The public sees
-- nothing here — a published collection page is served by
-- `app.get_public_collection`, which returns whitelisted fields only.
create policy collections_select_officer
  on public.collections for select to authenticated
  using (app.has_permission(community_id, 'community.view_dashboard'));

create policy collection_tiers_select_officer
  on public.collection_tiers for select to authenticated
  using (app.has_permission(community_id, 'community.view_dashboard'));

create policy collection_fields_select_officer
  on public.collection_fields for select to authenticated
  using (app.has_permission(community_id, 'community.view_dashboard'));

create policy collection_code_settings_select_officer
  on public.collection_code_settings for select to authenticated
  using (app.has_permission(community_id, 'community.view_dashboard'));


-- ── Obligations ──────────────────────────────────────────────────────────────
-- SEC-10: a collector sees only obligations inside their scope, which is why
-- this policy routes through `has_permission_for_collection` rather than the
-- community-level helper.
create policy obligations_select_officer
  on public.obligations for select to authenticated
  using (app.has_permission_for_collection(collection_id, 'transaction.view'));

-- SEC-11: a member sees their own obligations and no one else's.
create policy obligations_select_own_member
  on public.obligations for select to authenticated
  using (exists (
    select 1 from public.members m
    where m.id = obligations.member_id
      and m.user_id = (select auth.uid())
  ));


-- ── Audit log ────────────────────────────────────────────────────────────────
-- AUD-02: readable by owners, admins, treasurers and viewers — everyone holding
-- `audit.view`. AUD-03: that includes staff-access entries, which is the point.
create policy audit_logs_select_officer
  on public.audit_logs for select to authenticated
  using (community_id is not null and app.has_permission(community_id, 'audit.view'));


-- ─────────────────────────────────────────────────────────────────────────────
-- SEC-12: the ONE public surface
--
-- A published collection page, as whitelisted fields, for an anonymous caller.
-- This function is the entire anonymous read surface of the database. It is
-- SECURITY DEFINER, it takes a slug pair rather than an ID, and it returns
-- nothing about drafts, nothing about members, and nothing about money.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function app.get_public_collection(
  p_community_slug  text,
  p_collection_slug text
)
returns table (
  collection_id        uuid,
  collection_name      text,
  description          text,
  cover_image_url      text,
  category             public.collection_category,
  participation_mode   public.participation_mode,
  amount_model         public.amount_model,
  payment_plan         public.payment_plan,
  fixed_amount_kobo    bigint,
  min_amount_kobo      bigint,
  max_amount_kobo      bigint,
  target_amount_kobo   bigint,
  deadline_at          timestamptz,
  status               public.collection_status,
  display_options      jsonb,
  fee_mode             public.fee_mode,
  thank_you_message    text,
  community_name       text,
  community_logo_url   text,
  community_verified   public.verification_status
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.id, c.name, c.description, c.cover_image_url, c.category,
    c.participation_mode, c.amount_model, c.payment_plan,
    c.fixed_amount_kobo, c.min_amount_kobo, c.max_amount_kobo, c.target_amount_kobo,
    c.deadline_at, c.status, c.display_options, c.fee_mode, c.thank_you_message,
    com.name, com.logo_url, com.verification_status
  from public.collections c
  join public.communities com on com.id = c.community_id
  where com.slug = p_community_slug
    and c.slug   = p_collection_slug
    -- CON-08: closed, paused and suspended pages still resolve, so a contributor
    -- sees a clear state instead of a 404. Drafts never resolve.
    and c.status in ('active', 'paused', 'closed')
    and c.visibility in ('public', 'unlisted')
    and com.status = 'active';
$$;

comment on function app.get_public_collection(text, text) is
  'SEC-12: the entire anonymous read surface. Whitelisted fields for a published collection page. Never returns drafts, members, contributors or balances.';

-- Public tiers for the same page, same rules. Hidden tiers are not returned
-- (PRD 4.7: a sold-out tier is hidden, never deleted).
create or replace function app.get_public_collection_tiers(p_collection_id uuid)
returns table (
  tier_id         uuid,
  name            text,
  description     text,
  price_kobo      bigint,
  quantity_limit  integer,
  per_order_limit integer,
  sort_order      smallint
)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.name, t.description, t.price_kobo,
         t.quantity_limit, t.per_order_limit, t.sort_order
  from public.collection_tiers t
  join public.collections c on c.id = t.collection_id
  where t.collection_id = p_collection_id
    and not t.hidden
    and c.status in ('active', 'paused', 'closed')
    and c.visibility in ('public', 'unlisted')
  order by t.sort_order, t.name;
$$;

revoke all on function app.get_public_collection(text, text)       from public;
revoke all on function app.get_public_collection_tiers(uuid)       from public;
grant execute on function app.get_public_collection(text, text)    to anon, authenticated;
grant execute on function app.get_public_collection_tiers(uuid)    to anon, authenticated;
