-- ─────────────────────────────────────────────────────────────────────────────
-- 20261019130000 — Honour collector scope when reading the member roll (security)
--
-- Finding: the members_select_officer RLS policy gated on
-- app.has_permission(community_id, 'member.view_contact'), which does NOT read
-- role_permissions.scoped. The collector role holds member.view_contact as a
-- SCOPED permission (it should see only members within its assigned
-- collections), but the unscoped check let a collector SELECT every member row
-- in the community — full name, phone_e164 and email — directly over the REST
-- API, beyond its assigned scope. authenticated has `select on public.members`,
-- so RLS was the only gate and it ignored scope.
--
-- Fix: a scope-aware predicate that mirrors app.has_permission_for_collection
-- (SEC-10). Unscoped holders of member.view_contact (owner, admin, treasurer,
-- viewer) are unaffected — they still read the whole community roll. A collector
-- (the only scoped holder) may read a member only when that member has an
-- obligation in a collection within the collector's scope. This is the
-- obligations-based scope decision: a collector chases payment for the members
-- it was assigned collections for (ROLE-06 / SEC-10).
--
-- Parity note: as in has_permission_for_collection, a collector whose scope is
-- NULL or carries no collection_ids is treated as unrestricted, so this does
-- not silently narrow a collector that was deliberately given no collection
-- scope. The hole it closes is the normal case — a collector WITH a collection
-- scope seeing members outside it.
--
-- Not addressed here (distinct follow-ups, deliberately out of scope):
--   · Column masking (SEC-24, e.g. 0803***4521) is not enforced at the DB
--     layer; the app reads phone_e164/email raw. RLS is row-level and cannot
--     mask columns.
--   · Member-group scope: officer scope carries only collection_ids today.
--
-- Additive: new SECURITY DEFINER helper + an ALTER POLICY on the USING clause.
-- No grant, column, or other policy changes. The self-read policy
-- (members_select_self) is untouched. Rollback: restore the policy USING to
-- app.has_permission(community_id, 'member.view_contact') and drop the helper.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Scope-aware member visibility ────────────────────────────────────────────
-- SECURITY DEFINER so the obligations/role lookups bypass their own RLS without
-- recursing through the members policy that calls this. STABLE, language sql,
-- SET search_path = '' — the same shape as has_permission / has_permission_for_collection.
create or replace function app.can_view_member(
  p_member_id    uuid,
  p_community_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.officer_terms ot
    join public.role_permissions rp
      on rp.role = ot.role
     and rp.permission = 'member.view_contact'
    where ot.community_id = p_community_id
      and ot.user_id      = auth.uid()
      and ot.ended_at is null
      and ot.started_at <= now()
      and (
        -- Unscoped holder (owner/admin/treasurer/viewer): whole community.
        not rp.scoped
        -- A collector with no collection scope is unrestricted, matching
        -- has_permission_for_collection (SEC-10).
        or ot.scope is null
        or (ot.scope -> 'collection_ids') is null
        -- Scoped collector: only members with an obligation in one of the
        -- collections in scope.
        or exists (
          select 1
          from public.obligations o
          where o.member_id = p_member_id
            and (ot.scope -> 'collection_ids') @> to_jsonb(o.collection_id::text)
        )
      )
  );
$$;

comment on function app.can_view_member(uuid, uuid) is
  'SEC-10 (members): does the caller hold member.view_contact for this community AND, if the permission is scoped (collector), does the member have an obligation in a collection within the caller''s scope? Unscoped holders see the whole roll. Replaces the unscoped has_permission check in members_select_officer.';

revoke all     on function app.can_view_member(uuid, uuid) from public;
revoke execute on function app.can_view_member(uuid, uuid) from anon;
grant  execute on function app.can_view_member(uuid, uuid) to   authenticated;


-- ── Re-point the officer read policy at the scope-aware predicate ────────────
alter policy members_select_officer
  on public.members
  using (app.can_view_member(id, community_id));
