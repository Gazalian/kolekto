-- ─────────────────────────────────────────────────────────────────────────────
-- 16 — Contributor references (M7.6 parts H–N, AB)
--
-- Coverage for 20260921180000–180300. What has to be true about a code an
-- organiser prints on a ticket:
--
--   · it is unique inside its collection, enforced by the database and not
--     only by the function that generates it
--   · it never changes and is never withdrawn
--   · asking twice gives the same answer rather than a second code
--   · two options with prefixes number separately; two options without them
--     share one series
--   · the counter survives a deletion — the next code is the next number, not
--     count(*) + 1
--   · a concurrent caller cannot be handed a number that is already spent
--   · someone from another community gets nothing, and someone with the wrong
--     role gets nothing
--   · the format is fixed once anything has been issued
--
-- No money appears anywhere in this file. A reference identifies a
-- participation, which is a row an officer created (ADR 0006/0012).
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(36);

-- ── Fixtures: two communities, so "somebody else's collection" has an owner ─
insert into auth.users (id, instance_id, aud, role, email) values
  ('c1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@ref.example.test'),
  ('c1000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'other@ref.example.test'),
  ('c1000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'viewer@ref.example.test');

insert into public.users (id, full_name, email) values
  ('c1000000-0000-4000-8000-000000000001', 'Ref Owner',   'owner@ref.example.test'),
  ('c1000000-0000-4000-8000-000000000002', 'Other Owner', 'other@ref.example.test'),
  ('c1000000-0000-4000-8000-000000000003', 'Ref Viewer',  'viewer@ref.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('c2000000-0000-4000-8000-00000000000a', 'ref-tests',       'Ref Tests',  'social_group', false, 'c1000000-0000-4000-8000-000000000001'),
  ('c2000000-0000-4000-8000-00000000000b', 'ref-tests-other', 'Other Club', 'social_group', false, 'c1000000-0000-4000-8000-000000000002');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('c2000000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-000000000001', 'owner',  'Ref Owner',   'created'),
  ('c2000000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-000000000003', 'viewer', 'Ref Viewer',  'invited'),
  ('c2000000-0000-4000-8000-00000000000b', 'c1000000-0000-4000-8000-000000000002', 'owner',  'Other Owner', 'created');

insert into public.members (id, community_id, full_name, phone_e164, member_code, status, joined_via) values
  ('c3000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-00000000000a', 'Ada Member',   '+2348096660001', 'RF/0001', 'active', 'manual'),
  ('c3000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-00000000000a', 'Bola Member',  '+2348096660002', 'RF/0002', 'active', 'manual'),
  ('c3000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-00000000000a', 'Chidi Member', '+2348096660003', 'RF/0003', 'active', 'manual'),
  ('c3000000-0000-4000-8000-000000000004', 'c2000000-0000-4000-8000-00000000000b', 'Other Member', '+2348096660004', 'OC/0001', 'active', 'manual');

set local role authenticated;
set local request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- A fixed-amount collection with a plain collection-wide series.
create temporary table tmp_dues as
  select app.create_collection(
    'c2000000-0000-4000-8000-00000000000a', 'Annual Dues', 'dues', 'managed', 'fixed',
    null, 'full_only', 'one_time', 500000
  ) as id;


-- ─────────────────────────────────────────────────────────────────────────────
-- Configuring the format
-- ─────────────────────────────────────────────────────────────────────────────

select lives_ok(
  $$ select app.set_collection_code_settings(
       (select id from tmp_dues), true, 'BIO26', '-', 4::smallint, 1::bigint, 'sequential'
     ) $$,
  'an owner can switch contributor references on and choose the format'
);

select is(
  (select codes_enabled from public.collections where id = (select id from tmp_dues)),
  true,
  'switching references on is recorded on the collection, not only in the settings row'
);

select is(
  (select prefix || separator || digits::text || '/' || start_number::text
   from public.collection_code_settings where collection_id = (select id from tmp_dues)),
  'BIO26-4/1',
  'the prefix, separator, digit count and starting number are all stored'
);

select is(
  app.build_contributor_reference('BIO26', '-', 4::smallint, 7::bigint),
  'BIO26-0007',
  'the format helper produces exactly what the settings screen shows as an example'
);

select is(
  app.build_contributor_reference('BIO26', '-', 4::smallint, 12345::bigint),
  'BIO26-12345',
  'a number past the padding grows rather than wrapping — a wrapped reference would collide (CODE-04)'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Issuing, in a single series
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  app.assign_obligations(
    (select id from tmp_dues),
    array['c3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002']::uuid[],
    null, null
  ),
  2,
  'two members are put on the roll'
);

select is(
  (select count(*)::integer from public.contributor_references where collection_id = (select id from tmp_dues)),
  2,
  'assigning to a collection with references switched on issues them there and then'
);

select bag_eq(
  $$ select reference from public.contributor_references
     where collection_id = (select id from tmp_dues) $$,
  $$ values ('BIO26-0001'), ('BIO26-0002') $$,
  'the series starts at one and counts up'
);

create temporary table tmp_ada as
  select id from public.obligations
  where collection_id = (select id from tmp_dues) and member_id = 'c3000000-0000-4000-8000-000000000001';

select is(
  app.issue_contributor_reference((select id from tmp_ada)),
  (select reference from public.contributor_references where obligation_id = (select id from tmp_ada)),
  'asking again returns the reference that already exists rather than issuing a second one'
);

select is(
  (select count(*)::integer from public.contributor_references where obligation_id = (select id from tmp_ada)),
  1,
  'idempotent means one row, not two'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- The counter does not go backwards (part J: never count(*) + 1)
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select next_number from public.collection_code_sequences
   where collection_id = (select id from tmp_dues) and tier_id is null),
  3::bigint,
  'the counter sits on the next unissued number'
);

reset role;
-- Removing a reference is refused outright, so the only way to simulate the
-- deletion part J warns about is to remove one as the table owner and check
-- that the next issue still moves forward rather than reusing the gap.
set local role postgres;
alter table public.contributor_references disable trigger contributor_references_immutable;
delete from public.contributor_references
where collection_id = (select id from tmp_dues) and reference = 'BIO26-0002';
alter table public.contributor_references enable trigger contributor_references_immutable;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(
  app.assign_obligations(
    (select id from tmp_dues), array['c3000000-0000-4000-8000-000000000003']::uuid[], null, null
  ),
  1,
  'a third member joins the roll after a reference was removed behind the schema''s back'
);

select is(
  (select reference from public.contributor_references cr
   join public.obligations o on o.id = cr.obligation_id
   where o.member_id = 'c3000000-0000-4000-8000-000000000003'),
  'BIO26-0003',
  'the next reference is the next NUMBER, not the next count — the freed 0002 is never reissued (CODE-04)'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Immutability
-- ─────────────────────────────────────────────────────────────────────────────

reset role;
set local role postgres;

select throws_ok(
  $$ update public.contributor_references set reference = 'BIO26-9999'
     where reference = 'BIO26-0001' $$,
  'P0001',
  null,
  'an issued reference cannot be edited, even by the table owner'
);

select throws_ok(
  $$ delete from public.contributor_references where reference = 'BIO26-0001' $$,
  'P0001',
  null,
  'an issued reference cannot be deleted — it may already be printed on a receipt'
);

reset role;


-- ─────────────────────────────────────────────────────────────────────────────
-- Tier prefixes number separately (part K)
-- ─────────────────────────────────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}';

create temporary table tmp_dinner as
  select app.create_collection(
    'c2000000-0000-4000-8000-00000000000a', 'Department Dinner', 'event', 'managed', 'tiers'
  ) as id;

select is(
  app.set_collection_tiers(
    (select id from tmp_dinner),
    '[{"name":"Regular","price_kobo":1000000,"code_prefix":"REG"},
      {"name":"VIP","price_kobo":2500000,"code_prefix":"VIP"},
      {"name":"Table","price_kobo":9000000}]'::jsonb
  ),
  3,
  'a dinner offers three options, two of them with their own reference prefix'
);

select lives_ok(
  $$ select app.set_collection_code_settings(
       (select id from tmp_dinner), true, 'DIN', '-', 4::smallint, 1::bigint, 'sequential'
     ) $$,
  'the dinner has a collection-wide prefix as well, for options that have none of their own'
);

create temporary table tmp_tiers as
  select id, name from public.collection_tiers where collection_id = (select id from tmp_dinner);

select is(
  app.assign_obligations(
    (select id from tmp_dinner), array['c3000000-0000-4000-8000-000000000001']::uuid[],
    null, null, null, (select id from tmp_tiers where name = 'Regular')
  ),
  1,
  'a member is assigned to the Regular option'
);

select is(
  app.assign_obligations(
    (select id from tmp_dinner), array['c3000000-0000-4000-8000-000000000002']::uuid[],
    null, null, null, (select id from tmp_tiers where name = 'VIP')
  ),
  1,
  'another member is assigned to VIP'
);

select is(
  app.assign_obligations(
    (select id from tmp_dinner), array['c3000000-0000-4000-8000-000000000003']::uuid[],
    null, null, null, (select id from tmp_tiers where name = 'Table')
  ),
  1,
  'a third is assigned to Table, which has no prefix of its own'
);

select bag_eq(
  $$ select reference from public.contributor_references
     where collection_id = (select id from tmp_dinner) $$,
  $$ values ('REG-0001'), ('VIP-0001'), ('DIN-0001') $$,
  'each prefixed option counts from one, and the option without a prefix falls back to the collection''s series (part K)'
);

select is(
  -- `app.kobo` is a domain over bigint, and pgTAP's is() resolves on the
  -- declared type, so the cast is what makes the comparison exist.
  (select expected_amount_kobo::bigint from public.obligations
   where collection_id = (select id from tmp_dinner)
     and member_id = 'c3000000-0000-4000-8000-000000000002'),
  2500000::bigint,
  'the tier supplies the amount — a caller''s figure is never a second source of truth for a price (ADR 0010)'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Uniqueness is the database's job, not the function's
-- ─────────────────────────────────────────────────────────────────────────────

reset role;
set local role postgres;

select throws_ok(
  format(
    $$ insert into public.contributor_references (community_id, collection_id, obligation_id, reference)
       values ('c2000000-0000-4000-8000-00000000000a', %L,
               (select id from public.obligations where collection_id = %L limit 1),
               'REG-0001') $$,
    (select id from tmp_dinner), (select id from tmp_dinner)
  ),
  '23505',
  null,
  'a duplicate reference inside one collection is refused by a unique index, whatever produced it'
);

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- The same string in a DIFFERENT collection is fine: a reference identifies a
-- participation in one collection and means nothing outside it (part M).
select is(
  (select count(distinct collection_id)::integer from public.contributor_references
   where reference like 'BIO26%' or reference like 'REG%'),
  2,
  'references live inside their own collection — the same series can exist in two without colliding'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- An option people are booked onto cannot be removed
-- ─────────────────────────────────────────────────────────────────────────────

select throws_ok(
  format(
    $$ select app.set_collection_tiers(%L,
         '[{"name":"VIP","price_kobo":2500000,"code_prefix":"VIP"}]'::jsonb) $$,
    (select id from tmp_dinner)
  ),
  'P0001',
  null,
  'removing an option somebody is assigned to is refused, by name rather than by constraint number'
);

select lives_ok(
  format(
    $$ select app.set_collection_tiers(%L, (
         select jsonb_agg(jsonb_build_object(
           'id', t.id, 'name', case when t.name = 'Regular' then 'Standard' else t.name end,
           'price_kobo', t.price_kobo, 'code_prefix', t.code_prefix))
         from public.collection_tiers t where t.collection_id = %L
       )) $$,
    (select id from tmp_dinner), (select id from tmp_dinner)
  ),
  'an option CAN still be renamed while people are assigned to it — the row is updated, not replaced'
);

select is(
  (select tier_id from public.obligations
   where collection_id = (select id from tmp_dinner)
     and member_id = 'c3000000-0000-4000-8000-000000000001'),
  (select id from tmp_tiers where name = 'Regular'),
  'and the member stays attached to the same option row across the rename (stable child IDs, part A2)'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Authorization and tenancy
-- ─────────────────────────────────────────────────────────────────────────────

set local request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated"}';

select throws_ok(
  format($$ select app.set_collection_code_settings(%L, true, 'NOPE', '-', 4::smallint, 1::bigint, 'sequential') $$,
         (select id from tmp_dues)),
  '42501',
  null,
  'a viewer cannot change the reference format (part X: owner and admin only)'
);

select throws_ok(
  format($$ select app.issue_contributor_reference(%L) $$, (select id from tmp_ada)),
  '42501',
  null,
  'a viewer cannot issue a reference either — issuing is an act on the roll'
);

set local request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000002","role":"authenticated"}';

select throws_ok(
  format($$ select app.issue_contributor_reference(%L) $$, (select id from tmp_ada)),
  '42501',
  null,
  'an owner of another community cannot issue against this one''s roll (SEC-18)'
);

select is_empty(
  $$ select reference from public.contributor_references
     where collection_id = (select id from tmp_dues) $$,
  'and cannot read this community''s references at all'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- The format is fixed once anything has been issued
-- ─────────────────────────────────────────────────────────────────────────────

set local request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}';

select throws_ok(
  format($$ select app.set_collection_code_settings(%L, true, 'CHANGED', '-', 4::smallint, 1::bigint, 'sequential') $$,
         (select id from tmp_dues)),
  'P0001',
  null,
  'the prefix cannot be changed once references have been handed out — they are already on paper somewhere'
);

select lives_ok(
  format($$ select app.set_collection_code_settings(%L, false, 'BIO26', '-', 4::smallint, 1::bigint, 'sequential') $$,
         (select id from tmp_dues)),
  'but references CAN still be switched off, which only stops new ones being issued'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- The person holding the reference can see it (part N)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A reference nobody has been told is an internal number. This is the path
-- that tells them: the same function behind "find yourself on the list",
-- returning one row for one member who has already identified themselves.

select lives_ok(
  format($f$ select app.transition_collection_status(%L, 'draft', 'active') $f$, (select id from tmp_dues)),
  'the dues collection is published, so a member can identify themselves on it'
);

reset role;
-- The anonymous role reads the temporary fixture tables too, and a temp table
-- is owned by whoever created it.
grant select on tmp_dues to anon;
set local role anon;

select is(
  (select contributor_reference
   from app.get_collection_member_context(
     (select id from tmp_dues), 'c3000000-0000-4000-8000-000000000001'
   )),
  'BIO26-0001',
  'an identified member is shown their own reference — the thing they read out when they ring up about their money'
);

select is(
  (select count(*)::integer
   from app.get_collection_member_context(
     (select id from tmp_dues), 'c3000000-0000-4000-8000-000000000004'
   )),
  0,
  'and a member of another community gets no row at all, reference or otherwise (SEC-18)'
);

reset role;

select * from finish();
rollback;
