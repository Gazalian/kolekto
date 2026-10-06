-- ─────────────────────────────────────────────────────────────────────────────
-- 23 — Migration fixtures: can legacy history actually land here? (M8.2 §15–17)
--
-- Migration compatibility is a HARD requirement, not a later concern: the
-- existing Kolekto population and its history must eventually move onto this
-- schema. A schema that is cleaner but cannot represent what happened is not an
-- improvement, it is data loss with better naming.
--
-- So this file takes SYNTHETIC records shaped like the known legacy kinds and
-- proves each one can be stored without falsifying it. Every fixture below is
-- invented. There is no real personal data here: names are placeholders and every
-- address is on `example.test`, a reserved domain.
--
-- What it proves, concretely:
--
--   · a legacy record coexists with a new one, and is distinguishable on sight
--   · original identifiers and provenance survive
--   · an imported row cannot be edited afterwards
--   · a contributor who never had an account stays distinct from a real user
--   · a payment with no collection attribution is preserved WITHOUT inventing one
--   · importing history creates no ledger entries — no opening balances, ever
--
-- These fixtures are the canonical set for the migration engine milestone. When
-- that milestone builds transforms, it should exercise them rather than write new
-- ones, so the two cannot drift.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(43);

-- ── The import run: provenance starts here ──────────────────────────────────
--
-- Nothing may be imported without one. It is what makes "which run put this row
-- here, from which snapshot?" answerable years later.

insert into migration.import_runs (id, source_project, source_system, source_snapshot_label, status, started_at, notes)
values (
  'c0000000-0000-4000-8000-000000000001',
  'synthetic:m8-2-fixtures',
  'kolekto_legacy',
  'synthetic-fixture-snapshot-2026-09-24',
  'running',
  now(),
  'M8.2 synthetic fixtures. No real production data. Not a rehearsal of a real import.'
);

select is(
  (select source_system from migration.import_runs where id = 'c0000000-0000-4000-8000-000000000001'),
  'kolekto_legacy',
  'an import run names the system it read from'
);

select isnt(
  (select source_snapshot_label from migration.import_runs where id = 'c0000000-0000-4000-8000-000000000001'),
  null,
  'and the snapshot it read, so a re-run can be told apart from the first'
);


-- ── Identity: three kinds of legacy person ──────────────────────────────────
--
-- The distinction that matters most, and the one the brief calls out: a
-- contributor who paid but never had a Kolekto account must NOT become an
-- authenticated user. They are a member record at most.

insert into auth.users (id, instance_id, aud, role, email) values
  -- An organiser who had an account. Their auth UUID is PRESERVED, not reissued:
  -- a migrated user signing in must land on their own history.
  ('c1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'organiser@example.test'),
  -- A legacy user with no phone number on record. A known category, and it must
  -- not be blocked or invented.
  ('c1000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'nophone@example.test');

insert into public.users (id, full_name, email) values
  ('c1000000-0000-4000-8000-000000000001', 'Fixture Organiser', 'organiser@example.test'),
  ('c1000000-0000-4000-8000-000000000002', 'Fixture No Phone',  'nophone@example.test')
on conflict (id) do update set full_name = excluded.full_name;

select is(
  (select id from public.users where email = 'organiser@example.test'),
  'c1000000-0000-4000-8000-000000000001'::uuid,
  'a migrated user keeps their original auth UUID — no duplicate account is created'
);

select is(
  (select count(*)::integer from public.users where id = 'c1000000-0000-4000-8000-000000000002'),
  1,
  'a legacy user with no phone number is representable; the absence is not filled in with a guess'
);

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('c2000000-0000-4000-8000-000000000001', 'fixture-assoc', 'Fixture Association', 'fellowship', false,
   'c1000000-0000-4000-8000-000000000001');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'owner',
   'Fixture Organiser', 'migration');

select is(
  (select start_reason::text from public.officer_terms
   where community_id = 'c2000000-0000-4000-8000-000000000001'),
  'migration',
  'historical collection ownership is attributable, with `migration` as its own start reason'
);

-- The contributor who never had an account. A member row, imported, with no
-- user_id — and nothing anywhere turns them into a login.
--
-- Status is `unclaimed`, which is the status the schema provides for exactly
-- this: a person on the roll who has not claimed the record. It is NOT `active`,
-- because `members_active_has_phone` requires an active member to have a verified
-- number, and a legacy contributor may have had none. That constraint is doing
-- useful work here — it forces the migration to say which historical contributors
-- are claimable rather than marking the whole population active.
--
-- `joined_via = 'migration'` rather than `'import'`: both values exist, and the
-- former says how this person arrived.
insert into public.members
  (id, community_id, full_name, status, joined_via,
   is_imported, source_system, source_table, source_id, imported_at, import_run_id)
values
  ('c3000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001',
   'Fixture Contributor', 'unclaimed', 'migration',
   true, 'kolekto_legacy', 'contributions', 'd0000000-0000-4000-8000-000000000001',
   now(), 'c0000000-0000-4000-8000-000000000001');

select is(
  (select status::text from public.members where id = 'c3000000-0000-4000-8000-000000000001'),
  'unclaimed',
  'a historical contributor lands as `unclaimed` — on the roll, claimable later, not an account'
);

-- ── A finding, encoded as a test rather than only described ──────────────────
--
-- `members_active_has_phone` means a legacy person with NO phone number cannot be
-- an `active` member. For a contributor that is right (they are `unclaimed`). For
-- a legacy AUTHENTICATED user with no phone — a category the migration brief names
-- explicitly — it means the migration cannot mark them active either.
--
-- This is not a defect, and it is not something engineering should quietly work
-- around by relaxing the constraint. It is a decision about what a migrated
-- phone-less user's roll status should be. Asserted here so the constraint's
-- effect on the migration is a checked fact rather than a surprise during a
-- rehearsal.
select throws_ok(
  $$ insert into public.members
       (community_id, full_name, status, joined_via,
        is_imported, source_system, source_table, source_id, imported_at, import_run_id)
     values ('c2000000-0000-4000-8000-000000000001', 'Fixture No Phone Active', 'active', 'migration',
             true, 'kolekto_legacy', 'profiles', 'd0000000-0000-4000-8000-000000000009',
             now(), 'c0000000-0000-4000-8000-000000000001') $$,
  '23514',
  null,
  'a phone-less legacy person cannot be imported as an ACTIVE member — the migration must decide their status (reported as M8.2 finding F-M1)'
);

select is(
  (select count(*)::integer from public.members m
   join auth.users u on u.id = m.id
   where m.id = 'c3000000-0000-4000-8000-000000000001'),
  0,
  'a historical contributor is NOT an auth user — they may be claimed later, never converted silently'
);

select is(
  (select is_imported from public.members where id = 'c3000000-0000-4000-8000-000000000001'),
  true,
  'and they are distinguishable on sight as imported'
);

select is(
  (select source_id from public.members where id = 'c3000000-0000-4000-8000-000000000001'),
  'd0000000-0000-4000-8000-000000000001'::uuid,
  'with the original legacy identifier preserved'
);


-- ── Collections: every legacy shape ─────────────────────────────────────────
--
-- Fixed, tiered, open, fundraiser, ticketed, recurring, archived. Each imported,
-- each carrying provenance, each keeping its legacy slug.

insert into public.collections
  (id, community_id, slug, name, category, participation_mode, amount_model,
   fixed_amount_kobo, min_amount_kobo, target_amount_kobo, status, created_by, audience_mode,
   is_imported, source_system, source_table, source_id, imported_at, import_run_id)
values
  -- fixed
  ('c4000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001',
   'legacy-annual-dues', 'Legacy Annual Dues', 'dues', 'managed', 'fixed',
   500000, null, null, 'closed', 'c1000000-0000-4000-8000-000000000001', 'all_members',
   true, 'kolekto_legacy', 'collections', 'd4000000-0000-4000-8000-000000000001',
   now(), 'c0000000-0000-4000-8000-000000000001'),
  -- tiered / packages
  ('c4000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001',
   'legacy-banquet', 'Legacy Banquet', 'event', 'open', 'tiers',
   null, null, null, 'closed', 'c1000000-0000-4000-8000-000000000001', 'public',
   true, 'kolekto_legacy', 'collections', 'd4000000-0000-4000-8000-000000000002',
   now(), 'c0000000-0000-4000-8000-000000000001'),
  -- open amount
  ('c4000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000001',
   'legacy-offering', 'Legacy Offering', 'contribution', 'open', 'open_amount',
   null, 10000, null, 'closed', 'c1000000-0000-4000-8000-000000000001', 'public',
   true, 'kolekto_legacy', 'collections', 'd4000000-0000-4000-8000-000000000003',
   now(), 'c0000000-0000-4000-8000-000000000001'),
  -- fundraiser, with a target
  ('c4000000-0000-4000-8000-000000000004', 'c2000000-0000-4000-8000-000000000001',
   'legacy-borehole', 'Legacy Borehole Appeal', 'fundraiser', 'open', 'open_amount',
   null, null, 500000000, 'closed', 'c1000000-0000-4000-8000-000000000001', 'public',
   true, 'kolekto_legacy', 'collections', 'd4000000-0000-4000-8000-000000000004',
   now(), 'c0000000-0000-4000-8000-000000000001'),
  -- ticketed event
  ('c4000000-0000-4000-8000-000000000005', 'c2000000-0000-4000-8000-000000000001',
   'legacy-convention', 'Legacy Convention', 'event', 'open', 'tiers',
   null, null, null, 'closed', 'c1000000-0000-4000-8000-000000000001', 'public',
   true, 'kolekto_legacy', 'collections', 'd4000000-0000-4000-8000-000000000005',
   now(), 'c0000000-0000-4000-8000-000000000001'),
  -- recurring, historical
  ('c4000000-0000-4000-8000-000000000006', 'c2000000-0000-4000-8000-000000000001',
   'legacy-monthly-levy', 'Legacy Monthly Levy', 'dues', 'managed', 'fixed',
   200000, null, null, 'closed', 'c1000000-0000-4000-8000-000000000001', 'all_members',
   true, 'kolekto_legacy', 'collections', 'd4000000-0000-4000-8000-000000000006',
   now(), 'c0000000-0000-4000-8000-000000000001');

-- Archived / soft-deleted in the legacy system. Preserved, not discarded.
--
-- Its own statement because `collections_archived_has_timestamp` requires an
-- archived collection to carry the moment it was archived. That constraint is
-- right, and it is a migration requirement rather than an obstacle: the legacy
-- archive timestamp must be CARRIED, not replaced with `now()`, or every
-- historical collection would appear to have been archived on migration day.
insert into public.collections
  (id, community_id, slug, name, category, participation_mode, amount_model,
   status, archived_at, created_by, audience_mode,
   is_imported, source_system, source_table, source_id, imported_at, import_run_id)
values
  ('c4000000-0000-4000-8000-000000000007', 'c2000000-0000-4000-8000-000000000001',
   'legacy-abandoned-drive', 'Legacy Abandoned Drive', 'other', 'open', 'open_amount',
   'archived', '2026-03-05T11:00:00Z', 'c1000000-0000-4000-8000-000000000001', 'public',
   true, 'kolekto_legacy', 'collections', 'd4000000-0000-4000-8000-000000000007',
   now(), 'c0000000-0000-4000-8000-000000000001');

select is(
  (select archived_at from public.collections where source_id = 'd4000000-0000-4000-8000-000000000007'),
  '2026-03-05T11:00:00Z'::timestamptz,
  'and the legacy archive timestamp is carried, not replaced with migration day'
);

select is(
  (select count(*)::integer from public.collections
   where import_run_id = 'c0000000-0000-4000-8000-000000000001'),
  7,
  'seven legacy collection shapes all land: fixed, tiered, open, fundraiser, ticketed, recurring, archived'
);

select is(
  (select count(*)::integer from public.collections
   where import_run_id = 'c0000000-0000-4000-8000-000000000001' and not is_imported),
  0,
  'and every one of them is marked imported'
);

select is(
  (select slug from public.collections where source_id = 'd4000000-0000-4000-8000-000000000001'),
  'legacy-annual-dues',
  'a legacy slug is preserved, so old links can be made to resolve'
);

select is(
  (select status::text from public.collections where source_id = 'd4000000-0000-4000-8000-000000000007'),
  'archived',
  'an archived legacy collection is preserved as archived, not dropped because it was finished'
);

select is(
  (select fixed_amount_kobo::bigint from public.collections
   where source_id = 'd4000000-0000-4000-8000-000000000001'),
  500000::bigint,
  'and its amount is integer kobo, carried across without re-derivation'
);

-- Tiers for the tiered collection, because "tiers/options" is on the list of
-- things the migration must carry.
insert into public.collection_tiers (community_id, collection_id, name, price_kobo, sort_order) values
  ('c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000002', 'Legacy Table',  2500000, 1),
  ('c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000002', 'Legacy Single',  500000, 2);

select is(
  (select count(*)::integer from public.collection_tiers
   where collection_id = 'c4000000-0000-4000-8000-000000000002'),
  2,
  'legacy tiers land as rows with their own identity (ADR 0010), not as a jsonb array'
);

-- A collection that asked its own questions — "custom contributor fields" on the
-- migration list.
insert into public.collection_fields (community_id, collection_id, label, key, type, required, sort_order)
values
  ('c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000005',
   'Legacy hall of residence', 'legacy_hall', 'text', false, 1);

select is(
  (select count(*)::integer from public.collection_fields
   where collection_id = 'c4000000-0000-4000-8000-000000000005'),
  1,
  'a legacy collection''s custom contributor fields are representable'
);


-- ── Imported rows are immutable ─────────────────────────────────────────────

select throws_ok(
  $$ update public.collections set name = 'Renamed After Import'
     where id = 'c4000000-0000-4000-8000-000000000001' $$,
  'P0001',
  null,
  'an imported collection cannot be edited — a correction is a new row, never a rewrite of history'
);

select throws_ok(
  $$ delete from public.collections where id = 'c4000000-0000-4000-8000-000000000001' $$,
  'P0001',
  null,
  'and it cannot be deleted'
);

select is(
  (select name from public.collections where id = 'c4000000-0000-4000-8000-000000000001'),
  'Legacy Annual Dues',
  'and after both refusals it still says what the legacy system said'
);

select throws_ok(
  $$ update public.members set full_name = 'Renamed'
     where id = 'c3000000-0000-4000-8000-000000000001' $$,
  'P0001',
  null,
  'an imported member is immutable on the same terms'
);


-- ── Provenance is mandatory, and never invented ─────────────────────────────

select throws_ok(
  $$ insert into public.collections
       (community_id, slug, name, category, participation_mode, amount_model, created_by, audience_mode,
        is_imported)
     values ('c2000000-0000-4000-8000-000000000001', 'half-imported', 'Half Imported', 'other', 'open',
             'open_amount', 'c1000000-0000-4000-8000-000000000001', 'public', true) $$,
  '23514',
  null,
  'a row cannot claim to be imported without its provenance — no partial claims'
);

select throws_ok(
  $$ insert into public.collections
       (community_id, slug, name, category, participation_mode, amount_model, created_by, audience_mode,
        is_imported, source_system, source_table, source_id, imported_at, import_run_id)
     values ('c2000000-0000-4000-8000-000000000001', 'fake-provenance', 'Fake Provenance', 'other', 'open',
             'open_amount', 'c1000000-0000-4000-8000-000000000001', 'public',
             false, 'kolekto_legacy', 'collections', 'd9000000-0000-4000-8000-000000000001',
             now(), 'c0000000-0000-4000-8000-000000000001') $$,
  '23514',
  null,
  'and a row the new platform created cannot wear provenance it does not have'
);

-- The idempotency that makes a transform re-runnable against the same snapshot.
select throws_ok(
  $$ insert into public.collections
       (community_id, slug, name, category, participation_mode, amount_model, created_by, audience_mode,
        is_imported, source_system, source_table, source_id, imported_at, import_run_id)
     values ('c2000000-0000-4000-8000-000000000001', 'dupe-import', 'Dupe Import', 'other', 'open',
             'open_amount', 'c1000000-0000-4000-8000-000000000001', 'public',
             true, 'kolekto_legacy', 'collections', 'd4000000-0000-4000-8000-000000000001',
             now(), 'c0000000-0000-4000-8000-000000000001') $$,
  '23505',
  null,
  'the same legacy row cannot be imported twice — a transform can be re-run safely'
);


-- ── Financial history: preserved, and NOT converted into new truth ───────────

-- A historical paid contribution and a pending one, in the overflow table that
-- keeps whatever fields the legacy row had.
insert into migration.legacy_contribution (source_table, source_id, fields, import_run_id) values
  ('contributions', 'd5000000-0000-4000-8000-000000000001',
   jsonb_build_object(
     'legacy_id', 'd5000000-0000-4000-8000-000000000001',
     'collection_id', 'd4000000-0000-4000-8000-000000000001',
     'amount_kobo', 500000,
     'status', 'paid',
     'paystack_reference', 'LEGACY_REF_0001',
     'paid_at', '2026-03-01T10:00:00Z',
     'contributor_name', 'Fixture Contributor'),
   'c0000000-0000-4000-8000-000000000001'),
  ('contributions', 'd5000000-0000-4000-8000-000000000002',
   jsonb_build_object(
     'legacy_id', 'd5000000-0000-4000-8000-000000000002',
     'collection_id', 'd4000000-0000-4000-8000-000000000001',
     'amount_kobo', 500000,
     'status', 'pending',
     'paystack_reference', 'LEGACY_REF_0002'),
   'c0000000-0000-4000-8000-000000000001');

insert into migration.legacy_deposit (source_table, source_id, fields, import_run_id) values
  ('deposits', 'd6000000-0000-4000-8000-000000000001',
   jsonb_build_object(
     'legacy_id', 'd6000000-0000-4000-8000-000000000001',
     'amount_kobo', 500000,
     'status', 'success',
     'paystack_reference', 'LEGACY_REF_0001',
     'gateway_fee_kobo', 7500),
   'c0000000-0000-4000-8000-000000000001');

select is(
  (select count(*)::integer from migration.legacy_contribution
   where import_run_id = 'c0000000-0000-4000-8000-000000000001'),
  2,
  'a historical paid contribution and a historical pending one are both preserved'
);

select is(
  (select fields ->> 'status' from migration.legacy_contribution
   where source_id = 'd5000000-0000-4000-8000-000000000002'),
  'pending',
  'and a legacy status is kept VERBATIM rather than mapped onto a new enum that means something else'
);

select is(
  (select fields ->> 'paystack_reference' from migration.legacy_deposit
   where source_id = 'd6000000-0000-4000-8000-000000000001'),
  'LEGACY_REF_0001',
  'a historical provider reference survives, so a legacy receipt can still be traced'
);

-- The one with no collection attribution. Preserved in full, and the table has
-- no column in which to invent one.
insert into migration.unattributed_payments
  (source_table, source_id, payment_reference, amount_kobo, net_amount_kobo,
   original_created_at, original_paid_at, original_status, raw_payload, import_run_id, notes)
values
  ('deposits', 'd7000000-0000-4000-8000-000000000001', 'LEGACY_REF_ORPHAN_0001',
   1000000, 985000, '2026-02-01T09:00:00Z', '2026-02-01T09:05:00Z', 'success',
   jsonb_build_object('__synthetic', true, 'reference', 'LEGACY_REF_ORPHAN_0001'),
   'c0000000-0000-4000-8000-000000000001',
   'Synthetic fixture for the no-attribution shape. Not a real record.');

select hasnt_column('migration', 'unattributed_payments', 'collection_id',
  'a payment with no collection has nowhere to put one — which is what makes a well-meaning future backfill impossible');

select is(
  (select original_status from migration.unattributed_payments
   where payment_reference = 'LEGACY_REF_ORPHAN_0001'),
  'success',
  'its original status is preserved verbatim, not reinterpreted');

select throws_ok(
  $$ update migration.unattributed_payments set amount_kobo = 1
     where payment_reference = 'LEGACY_REF_ORPHAN_0001' $$,
  'P0001',
  null,
  'and it cannot be edited into attribution later'
);

-- A legacy contributor code, and a legacy URL that must keep resolving.
-- `old_path` carries no leading slash, so comparing it against a trimmed request
-- path is unambiguous. `new_path` is not null, so a code with no destination is
-- recorded as pointing at the collection it belonged to.
insert into public.legacy_links (old_path, new_path, kind, collection_id, notes) values
  ('c/old-slug-annual-dues', '/fixture-assoc/legacy-annual-dues', 'collection_slug',
   'c4000000-0000-4000-8000-000000000001', 'Synthetic fixture.'),
  ('receipt/LEGACY_REF_0001', '/fixture-assoc/legacy-annual-dues', 'receipt',
   'c4000000-0000-4000-8000-000000000001', 'Synthetic fixture.'),
  ('code/DUES-0042', '/fixture-assoc/legacy-annual-dues', 'contributor_code',
   'c4000000-0000-4000-8000-000000000001', 'Synthetic fixture.');

select is(
  (select count(*)::integer from public.legacy_links
   where collection_id = 'c4000000-0000-4000-8000-000000000001'),
  3,
  'a legacy slug, a legacy receipt URL and a legacy contributor code all have somewhere to resolve from'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- THE ASSERTION THIS WHOLE FILE EXISTS FOR
--
-- Importing history created no financial truth. Not one ledger row.
--
-- The old system's `wallets` table held five mutable numbers per collection and
-- they are the single most tempting thing to carry across, because they look like
-- balances. They were a cache. Turning them into opening balances would put
-- numbers in the ledger that no entry explains — which is the precise property
-- this entire architecture exists to prevent (D-23).
-- ─────────────────────────────────────────────────────────────────────────────

select is(
  (select count(*)::integer from public.ledger_entries),
  0,
  'importing seven collections, a member, two contributions, a deposit and an orphaned payment created ZERO ledger entries'
);

select is(
  (select count(*)::integer from public.ledger_journals),
  0,
  'and zero journals — imported history never enters the ledger (D-23)'
);

select is(
  (select count(*)::integer from public.ledger_accounts),
  0,
  'and not even an account, so there is nothing for an opening balance to sit in'
);

select is(
  (select coalesce(sum(pending_kobo), 0)::bigint from public.v_collection_position
   where collection_id in (
     select id from public.collections where import_run_id = 'c0000000-0000-4000-8000-000000000001')),
  0::bigint,
  'every imported collection reports a position of zero — its legacy money is history, not a balance'
);


-- ── Reconciliation counts: the migration must be able to report on itself ───
--
-- §17: no migration is successful merely because the SQL completed. These are the
-- shapes of the counts a real run must produce.

select is(
  (select count(*)::integer from public.collections
   where import_run_id = 'c0000000-0000-4000-8000-000000000001'),
  7,
  'collections imported by this run are countable, for a source-versus-target check'
);

select is(
  (select count(*)::integer from public.members
   where import_run_id = 'c0000000-0000-4000-8000-000000000001'),
  1,
  'and members'
);

select is(
  (select count(*)::integer from migration.unattributed_payments
   where import_run_id = 'c0000000-0000-4000-8000-000000000001'),
  1,
  'and records needing manual review are counted separately rather than hidden among the rest'
);

-- Grouping by legacy status is how "imported historical records by status" is
-- answered without reinterpreting any of them.
select results_eq(
  $$ select fields ->> 'status', count(*)::integer
     from migration.legacy_contribution
     where import_run_id = 'c0000000-0000-4000-8000-000000000001'
     group by 1 order by 1 $$,
  $$ values ('paid', 1), ('pending', 1) $$,
  'imported history can be counted by its ORIGINAL status, which is what makes a reconciliation report possible'
);

-- Provenance makes every imported row traceable to one run, which is what lets a
-- failed run be identified and re-run rather than guessed at.
select is_empty(
  $$ select id from public.collections where is_imported and import_run_id is null $$,
  'no imported row is orphaned from its import run'
);


-- ── The client cannot read the migration schema at all ──────────────────────

select ok(
  not has_table_privilege('authenticated', 'migration.legacy_contribution', 'SELECT'),
  'legacy overflow tables hold whatever the old system held, including contact details, so no client reads them'
);

select ok(
  not has_table_privilege('anon', 'migration.unattributed_payments', 'SELECT'),
  'and anon reads nothing anywhere'
);

select * from finish();
rollback;
