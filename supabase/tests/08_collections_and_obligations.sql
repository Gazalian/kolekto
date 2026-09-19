-- ─────────────────────────────────────────────────────────────────────────────
-- 08 — Phase 3 collections and obligations
--
-- Behavioural coverage for 20260919120000: every collection and obligation
-- write function, exercised as a caller who holds the permission and as one who
-- does not (SEC-16), plus the rules this phase exists to make structural:
--
--   · a collection belongs to a community, and another community's officer
--     cannot see it, edit it or assign against it (ADR 0004, SEC-18)
--   · tiers are matched by identity, never by display name (ADR 0010 — the
--     2026-08-06 incident)
--   · the amount a member is expected to pay comes from the collection, not
--     from the caller, wherever the collection already states it
--   · nothing anywhere marks anything paid (CASH-02, SEC-20a)
--   · the anonymous surface returns published collections only, never drafts
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(58);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email) values
  ('c0110000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-a@col.example.test'),
  ('c0110000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'viewer-a@col.example.test'),
  ('c0110000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-b@col.example.test');

insert into public.users (id, full_name, email) values
  ('c0110000-0000-4000-8000-000000000001', 'Owner A',  'owner-a@col.example.test'),
  ('c0110000-0000-4000-8000-000000000002', 'Viewer A', 'viewer-a@col.example.test'),
  ('c0110000-0000-4000-8000-000000000003', 'Owner B',  'owner-b@col.example.test')
on conflict (id) do update set full_name = excluded.full_name, email = excluded.email;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('c0110000-0000-4000-8000-00000000000a', 'collection-tests-a', 'Collection Tests A', 'fellowship',  false, 'c0110000-0000-4000-8000-000000000001'),
  ('c0110000-0000-4000-8000-00000000000b', 'collection-tests-b', 'Collection Tests B', 'cooperative', false, 'c0110000-0000-4000-8000-000000000003');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('c0110000-0000-4000-8000-00000000000a', 'c0110000-0000-4000-8000-000000000001', 'owner',  'Owner A',  'created'),
  ('c0110000-0000-4000-8000-00000000000a', 'c0110000-0000-4000-8000-000000000002', 'viewer', 'Viewer A', 'invited'),
  ('c0110000-0000-4000-8000-00000000000b', 'c0110000-0000-4000-8000-000000000003', 'owner',  'Owner B',  'created');

insert into public.members (id, community_id, full_name, phone_e164, status, joined_via, created_by) values
  ('c0110000-0000-4000-8000-0000000000f1', 'c0110000-0000-4000-8000-00000000000a', 'Member One', '+2348010000001', 'active', 'manual', 'c0110000-0000-4000-8000-000000000001'),
  ('c0110000-0000-4000-8000-0000000000f2', 'c0110000-0000-4000-8000-00000000000a', 'Member Two', '+2348010000002', 'active', 'manual', 'c0110000-0000-4000-8000-000000000001'),
  ('c0110000-0000-4000-8000-0000000000fb', 'c0110000-0000-4000-8000-00000000000b', 'Member B',   '+2348010000003', 'active', 'manual', 'c0110000-0000-4000-8000-000000000003');


-- ─────────────────────────────────────────────────────────────────────────────
-- create_collection
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"c0110000-0000-4000-8000-000000000001","role":"authenticated"}';

create temporary table tmp_fixed as
  select app.create_collection(
    'c0110000-0000-4000-8000-00000000000a', 'Departmental Dues 2026', 'dues',
    'managed', 'fixed', 'Annual dues for every member', 'full_only', 'one_time',
    500000
  ) as id;

create temporary table tmp_same_name as
  select app.create_collection(
    'c0110000-0000-4000-8000-00000000000a', 'Departmental Dues 2026', 'dues',
    'open', 'fixed', null, 'full_only', 'one_time', 500000
  ) as id;

reset role;

select ok(
  exists (
    select 1 from public.collections
    where id = (select id from tmp_fixed)
      and status = 'draft'
      and community_id = 'c0110000-0000-4000-8000-00000000000a'
      and fixed_amount_kobo = 500000
  ),
  'create_collection creates a DRAFT collection owned by the community (ADR 0004)'
);

select is(
  (select slug from public.collections where id = (select id from tmp_fixed)),
  'departmental-dues-2026',
  'the collection slug is derived from its name'
);

select is(
  (select slug from public.collections where id = (select id from tmp_same_name)),
  'departmental-dues-2026-2',
  'a second collection with the same name gets a distinct slug in the same community'
);

select ok(
  exists (
    select 1 from public.audit_logs
    where object_type = 'collection' and object_id = (select id from tmp_fixed) and action = 'collection.create'
  ),
  'creating a collection writes an audit row (AUD-01)'
);

-- SEC-16: the same call, by someone who holds community.view_dashboard but not
-- collection.draft.
set local role authenticated;
set local request.jwt.claims = '{"sub":"c0110000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok(
  $$ select app.create_collection(
       'c0110000-0000-4000-8000-00000000000a', 'Viewer Attempt', 'dues', 'open', 'fixed', null, 'full_only', 'one_time', 100000
     ) $$,
  '42501', null,
  'a viewer cannot create a collection (collection.draft)'
);
reset role;

-- SEC-18: passing another community's id does not make it yours.
set local role authenticated;
set local request.jwt.claims = '{"sub":"c0110000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok(
  $$ select app.create_collection(
       'c0110000-0000-4000-8000-00000000000a', 'Cross Tenant Attempt', 'dues', 'open', 'fixed', null, 'full_only', 'one_time', 100000
     ) $$,
  '42501', null,
  'an officer of another community cannot create a collection in this one'
);
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"c0110000-0000-4000-8000-000000000001","role":"authenticated"}';

select throws_ok(
  $$ select app.create_collection(
       'c0110000-0000-4000-8000-00000000000a', 'No Amount', 'dues', 'open', 'fixed', null, 'full_only', 'one_time', 0
     ) $$,
  'P0001', null,
  'a fixed collection cannot be created with an amount of zero'
);

select throws_ok(
  $$ select app.create_collection(
       'c0110000-0000-4000-8000-00000000000a', 'Fixed With Range', 'dues', 'open', 'fixed', null, 'full_only', 'one_time', 500000, 100000, 900000
     ) $$,
  'P0001', null,
  'a fixed collection cannot also carry a minimum and maximum'
);

select throws_ok(
  $$ select app.create_collection(
       'c0110000-0000-4000-8000-00000000000a', 'Open Per Member', 'dues', 'open', 'per_member'
     ) $$,
  'P0001', null,
  'a per-member amount requires a managed collection'
);

select throws_ok(
  $$ select app.create_collection(
       'c0110000-0000-4000-8000-00000000000a', 'Backwards Range', 'contribution', 'open', 'open_amount',
       null, 'full_only', 'one_time', null, 900000, 100000
     ) $$,
  'P0001', null,
  'the smallest allowed contribution cannot exceed the largest'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Tiers (ADR 0010)
-- ─────────────────────────────────────────────────────────────────────────────
create temporary table tmp_tiered as
  select app.create_collection(
    'c0110000-0000-4000-8000-00000000000a', 'Alumni Dinner 2026', 'event',
    'open', 'tiers', 'Dinner and awards night'
  ) as id;

create temporary table tmp_tiered_empty as
  select app.create_collection(
    'c0110000-0000-4000-8000-00000000000a', 'Nothing On Sale Yet', 'event',
    'open', 'tiers'
  ) as id;

select is(
  app.set_collection_tiers(
    (select id from tmp_tiered),
    '[{"name": "Standard", "price_kobo": "500000", "sort_order": 0},
      {"name": "VIP", "price_kobo": "2000000", "quantity_limit": 20, "sort_order": 1}]'::jsonb
  ),
  2,
  'set_collection_tiers writes the options it was given'
);

select throws_ok(
  $$ select app.set_collection_tiers(
       (select id from tmp_tiered),
       '[{"name": "Standard", "price_kobo": "500000"}, {"name": "standard", "price_kobo": "900000"}]'::jsonb
     ) $$,
  'P0001', null,
  'two options with the same name are refused, case-insensitively (ADR 0010, the 2026-08-06 incident)'
);

select throws_ok(
  $$ select app.set_collection_tiers(
       (select id from tmp_tiered),
       '[{"name": "Free Ride", "price_kobo": "0"}]'::jsonb
     ) $$,
  'P0001', null,
  'an option priced at zero is refused'
);

select throws_ok(
  $$ select app.set_collection_tiers(
       (select id from tmp_fixed),
       '[{"name": "Standard", "price_kobo": "500000"}]'::jsonb
     ) $$,
  'P0001', null,
  'a collection that is not tiered cannot be given options'
);

reset role;

create temporary table tmp_vip_id as
  select id from public.collection_tiers
  where collection_id = (select id from tmp_tiered) and name = 'VIP';

-- Created while the superuser role is active, so the impersonated calls below
-- need their own read grant on it.
grant select on tmp_vip_id to authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub":"c0110000-0000-4000-8000-000000000001","role":"authenticated"}';

-- An option carried through a rename keeps its ID. This is the whole of ADR
-- 0010: identity is the ID, and the display name is a label.
select is(
  app.set_collection_tiers(
    (select id from tmp_tiered),
    (select jsonb_build_array(
       jsonb_build_object('name', 'Standard', 'price_kobo', '500000'),
       jsonb_build_object('id', (select id from tmp_vip_id), 'name', 'Platinum', 'price_kobo', '2500000')
     ))
  ),
  2,
  'an option can be renamed and repriced in place'
);

-- A tier ID from a different collection is refused rather than adopted. Both
-- collections here are tiered drafts, so the refusal is about identity and
-- nothing else.
select throws_ok(
  format(
    $$ select app.set_collection_tiers(%L, %L::jsonb) $$,
    (select id from tmp_tiered_empty),
    jsonb_build_array(jsonb_build_object('id', (select id from tmp_vip_id), 'name', 'Stolen', 'price_kobo', '100'))::text
  ),
  'P0002', null,
  'an option ID belonging to another collection is refused, not adopted (SEC-18)'
);

reset role;

select ok(
  exists (
    select 1 from public.collection_tiers
    where id = (select id from tmp_vip_id) and name = 'Platinum' and price_kobo = 2500000
  ),
  'the renamed option kept its identity — the same row, not a replacement (ADR 0010)'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Custom questions (PRD 4.3)
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"c0110000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(
  app.set_collection_fields(
    (select id from tmp_fixed),
    '[{"key": "matric_number", "label": "Matric number", "type": "text", "required": true},
      {"key": "level", "label": "Level", "type": "single_select", "options": ["100", "200", "300"]}]'::jsonb
  ),
  2,
  'set_collection_fields writes the questions it was given'
);

select throws_ok(
  $$ select app.set_collection_fields(
       (select id from tmp_fixed),
       '[{"key": "Matric Number", "label": "Matric number", "type": "text"}]'::jsonb
     ) $$,
  'P0001', null,
  'a question key that is not a safe identifier is refused'
);

select throws_ok(
  $$ select app.set_collection_fields(
       (select id from tmp_fixed),
       '[{"key": "level", "label": "Level", "type": "single_select"}]'::jsonb
     ) $$,
  'P0001', null,
  'a choice question with no options is refused'
);

select throws_ok(
  $$ select app.set_collection_fields(
       (select id from tmp_fixed),
       (select jsonb_agg(jsonb_build_object('key', 'q' || i, 'label', 'Question ' || i, 'type', 'text'))
        from generate_series(1, 11) as i)
     ) $$,
  'P0001', null,
  'more than ten questions is refused (PRD 4.3)'
);

reset role;


-- ─────────────────────────────────────────────────────────────────────────────
-- The state machine (STM-01)
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"c0110000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok(
  format($$ select app.transition_collection_status(%L, 'draft', 'active') $$, (select id from tmp_fixed)),
  '42501', null,
  'a viewer cannot publish a collection (collection.publish)'
);
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"c0110000-0000-4000-8000-000000000001","role":"authenticated"}';

select throws_ok(
  format($$ select app.transition_collection_status(%L, 'active', 'paused') $$, (select id from tmp_fixed)),
  'P0001', null,
  'a transition whose stated current status is wrong is refused (compare-and-set)'
);

select throws_ok(
  format($$ select app.transition_collection_status(%L, 'draft', 'suspended') $$, (select id from tmp_fixed)),
  '42501', null,
  'a community officer cannot suspend a collection — suspension is a Kolekto risk action'
);

select throws_ok(
  format($$ select app.transition_collection_status(%L, 'draft', 'active') $$, (select id from tmp_tiered_empty)),
  'P0001', null,
  'a tiered collection with no visible option cannot be published'
);

select is(
  app.transition_collection_status((select id from tmp_fixed), 'draft', 'active')::text,
  'active',
  'draft publishes to active'
);

select throws_ok(
  format($$ select app.transition_collection_status(%L, 'active', 'archived') $$, (select id from tmp_fixed)),
  'P0001', null,
  'an active collection cannot jump straight to archived'
);

select is(
  app.transition_collection_status((select id from tmp_fixed), 'active', 'paused')::text,
  'paused',
  'active pauses'
);

select is(
  app.transition_collection_status((select id from tmp_fixed), 'paused', 'active')::text,
  'active',
  'paused resumes'
);

select is(
  app.transition_collection_status((select id from tmp_tiered), 'draft', 'active')::text,
  'active',
  'a tiered collection with a visible option publishes'
);

reset role;

select ok(
  (select published_at is not null and published_by = 'c0110000-0000-4000-8000-000000000001'
   from public.collections where id = (select id from tmp_fixed)),
  'publishing records who published it and when'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- update_collection: the amount lock
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"c0110000-0000-4000-8000-000000000001","role":"authenticated"}';

select lives_ok(
  format(
    $$ select app.update_collection(%L, 'Departmental Dues 2026 (revised)', 'dues', 'Now with a longer description',
         'fixed', 'managed', 'full_only', 500000) $$,
    (select id from tmp_fixed)
  ),
  'a published collection''s wording can still be edited'
);

select throws_ok(
  format(
    $$ select app.update_collection(%L, 'Departmental Dues 2026 (revised)', 'dues', null,
         'fixed', 'managed', 'full_only', 900000) $$,
    (select id from tmp_fixed)
  ),
  'P0001', null,
  'a published collection''s amount cannot be changed (collection.change_amount needs a second approver)'
);

select throws_ok(
  format(
    $$ select app.set_collection_tiers(%L, '[{"name": "Standard", "price_kobo": "100"}]'::jsonb) $$,
    (select id from tmp_tiered)
  ),
  'P0001', null,
  'a published collection''s options cannot be rewritten'
);

select lives_ok(
  format($$ select app.set_tier_hidden(%L, true) $$, (select id from tmp_vip_id)),
  'an option can still be hidden after publication (PRD 4.7)'
);

reset role;


-- ─────────────────────────────────────────────────────────────────────────────
-- Obligations
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"c0110000-0000-4000-8000-000000000001","role":"authenticated"}';

-- The member list carries an id from community B. It matches nothing.
select is(
  app.assign_obligations(
    (select id from tmp_fixed),
    array['c0110000-0000-4000-8000-0000000000f1',
          'c0110000-0000-4000-8000-0000000000f2',
          'c0110000-0000-4000-8000-0000000000fb']::uuid[]
  ),
  2,
  'assigning skips a member id from another community (SEC-18)'
);

select is(
  app.assign_obligations(
    (select id from tmp_fixed),
    array['c0110000-0000-4000-8000-0000000000f1']::uuid[]
  ),
  0,
  'assigning a member who already has an obligation creates nothing'
);

select throws_ok(
  format(
    $$ select app.assign_obligations(%L, array['c0110000-0000-4000-8000-0000000000f1']::uuid[], 100000) $$,
    (select id from tmp_fixed)
  ),
  'P0001', null,
  'the caller cannot set a different amount on a collection that charges everyone the same'
);

select throws_ok(
  format(
    $$ select app.assign_obligations(%L, array['c0110000-0000-4000-8000-0000000000f1']::uuid[]) $$,
    (select id from tmp_tiered)
  ),
  'P0001', null,
  'an open collection has nobody to assign — there is no member list'
);

reset role;

select is(
  (select expected_amount_kobo::bigint from public.obligations
   where collection_id = (select id from tmp_fixed)
     and member_id = 'c0110000-0000-4000-8000-0000000000f1'),
  500000::bigint,
  'the expected amount comes from the collection, not from the caller'
);

select is(
  (select status::text from public.obligations
   where collection_id = (select id from tmp_fixed)
     and member_id = 'c0110000-0000-4000-8000-0000000000f1'),
  'unpaid',
  'a new obligation is unpaid — nothing in this phase makes it anything else'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"c0110000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok(
  format(
    $$ select app.assign_obligations(%L, array['c0110000-0000-4000-8000-0000000000f2']::uuid[]) $$,
    (select id from tmp_fixed)
  ),
  '42501', null,
  'a viewer cannot assign obligations (obligation.assign)'
);
reset role;

create temporary table tmp_obligation as
  select id from public.obligations
  where collection_id = (select id from tmp_fixed)
    and member_id = 'c0110000-0000-4000-8000-0000000000f2';

grant select on tmp_obligation to authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub":"c0110000-0000-4000-8000-000000000001","role":"authenticated"}';

select throws_ok(
  format($$ select app.exempt_obligation(%L, '   ') $$, (select id from tmp_obligation)),
  'P0001', null,
  'exempting a member without a reason is refused (OBL-07)'
);

select throws_ok(
  format($$ select app.waive_obligation_amount(%L, 900000, 'Hardship') $$, (select id from tmp_obligation)),
  'P0001', null,
  'more cannot be waived than the member was asked for'
);

select lives_ok(
  format($$ select app.waive_obligation_amount(%L, 200000, 'Hardship, agreed at the March meeting') $$,
         (select id from tmp_obligation)),
  'part of a balance can be waived, with a reason (OBL-08)'
);

select lives_ok(
  format($$ select app.exempt_obligation(%L, 'Left the department') $$, (select id from tmp_obligation)),
  'a member can be exempted, with a reason (OBL-07)'
);

reset role;

select is(
  (select status::text from public.obligations where id = (select id from tmp_obligation)),
  'exempt',
  'an exempted obligation reads as exempt — an exemption is never a payment (CASH-02)'
);

-- SEC-20a: the rule this whole phase is built not to break.
select throws_ok(
  format($$ update public.obligations set status = 'paid' where id = %L $$, (select id from tmp_obligation)),
  'P0001', null,
  'nothing in this phase can mark an obligation paid (CASH-02, SEC-20a)'
);

select throws_ok(
  format($$ delete from public.obligations where id = %L $$, (select id from tmp_obligation)),
  'P0001', null,
  'an obligation is never deleted (OBL-05)'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Deleting a draft (COL-14)
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"c0110000-0000-4000-8000-000000000001","role":"authenticated"}';

select lives_ok(
  format($$ select app.delete_draft_collection(%L) $$, (select id from tmp_same_name)),
  'an unpublished draft with no obligations can be discarded'
);

select throws_ok(
  format($$ select app.delete_draft_collection(%L) $$, (select id from tmp_fixed)),
  'P0001', null,
  'a published collection is never deleted (COL-14)'
);

reset role;


-- ─────────────────────────────────────────────────────────────────────────────
-- Tenancy: another community's officer sees and touches nothing
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"c0110000-0000-4000-8000-000000000003","role":"authenticated"}';

select is(
  (select count(*)::integer from public.collections
   where community_id = 'c0110000-0000-4000-8000-00000000000a'),
  0,
  'an officer of another community reads none of this community''s collections (RLS)'
);

select is(
  (select count(*)::integer from public.obligations
   where community_id = 'c0110000-0000-4000-8000-00000000000a'),
  0,
  'an officer of another community reads none of this community''s obligations (RLS)'
);

select throws_ok(
  format(
    $$ select app.transition_collection_status(%L, 'active', 'closed') $$,
    (select id from tmp_fixed)
  ),
  '42501', null,
  'an officer of another community cannot close this community''s collection'
);

reset role;


-- ─────────────────────────────────────────────────────────────────────────────
-- SEC-12: the anonymous surface
-- ─────────────────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"c0110000-0000-4000-8000-000000000001","role":"authenticated"}';
create temporary table tmp_draft as
  select app.create_collection(
    'c0110000-0000-4000-8000-00000000000a', 'Unpublished Idea', 'other', 'open', 'open_amount'
  ) as id;
reset role;

-- These temp tables are owned by `authenticated` (the role active when CREATE
-- ran). The anonymous calls below need to read the ids out of them; a real
-- anonymous request carries the slug in the URL and never touches a temp table.
grant select on tmp_fixed, tmp_draft to anon;

set local role anon;

select is(
  (select count(*)::integer from app.get_public_collection('collection-tests-a', 'unpublished-idea')),
  0,
  'a draft never resolves on the public surface (SEC-12)'
);

select is(
  (select collection_name from app.get_public_collection('collection-tests-a', 'departmental-dues-2026')),
  'Departmental Dues 2026 (revised)',
  'a published collection resolves anonymously by community slug and collection slug'
);

select is(
  (select count(*)::integer from app.get_public_collection_fields((select id from tmp_fixed))),
  2,
  'the published collection''s questions are readable anonymously, so the form can be rendered'
);

select is(
  (select count(*)::integer from app.get_public_collection_fields((select id from tmp_draft))),
  0,
  'a draft''s questions are not readable anonymously'
);

reset role;

select * from finish();
rollback;
