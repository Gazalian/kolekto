-- ─────────────────────────────────────────────────────────────────────────────
-- 74 — Public community page (20261122140000) and profile photos (20261122130000)
--
--   · an unpublished community has no public page, and its collections none
--   · only the OWNER can publish: admin, outsider and anon are refused
--   · a personal workspace cannot publish
--   · the public read returns whitelisted identity fields; contact details
--     only when the owner turned them on; verification status as stored
--   · only visibility = 'public' collections in active / paused / closed are
--     listed; link-only, members-only, drafts and archived never are
--   · unpublishing removes the page again; every change is audited
--   · set_my_avatar: own folder + server-style name only; returns the previous
--     URL; clearing works; anon refused; audited
--   · the avatar bucket is public, 2 MiB, three image types, with no storage
--     policy (no listing, no client writes)
--   · nothing here touches the ledger
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(35);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('a7410000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@public74.example.test', now()),
  ('a7410000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin@public74.example.test', now()),
  ('a7410000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'outsider@public74.example.test', now());
insert into public.users (id, full_name, email, identity_level) values
  ('a7410000-0000-4000-8000-000000000001', 'Public Owner',    'owner@public74.example.test',    'contact_verified'),
  ('a7410000-0000-4000-8000-000000000002', 'Public Admin',    'admin@public74.example.test',    'contact_verified'),
  ('a7410000-0000-4000-8000-000000000009', 'Public Outsider', 'outsider@public74.example.test', 'contact_verified')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by, description, contact_email, location_city) values
  ('a7420000-0000-4000-8000-00000000000a', 'public-74', 'Public Seventy Four', 'social_group', false,
   'a7410000-0000-4000-8000-000000000001', 'We meet monthly.', 'hello@public74.example.test', 'Lagos'),
  ('a7420000-0000-4000-8000-00000000000b', 'quiet-74', 'Quiet Seventy Four', 'social_group', false,
   'a7410000-0000-4000-8000-000000000001', null, null, null),
  ('a7420000-0000-4000-8000-00000000000c', 'personal-74', 'Personal Seventy Four', 'personal', true,
   'a7410000-0000-4000-8000-000000000001', null, null, null);

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('a7420000-0000-4000-8000-00000000000a', 'a7410000-0000-4000-8000-000000000001', 'owner', 'Public Owner', 'created'),
  ('a7420000-0000-4000-8000-00000000000a', 'a7410000-0000-4000-8000-000000000002', 'admin', 'Public Admin', 'invited'),
  ('a7420000-0000-4000-8000-00000000000b', 'a7410000-0000-4000-8000-000000000001', 'owner', 'Public Owner', 'created'),
  ('a7420000-0000-4000-8000-00000000000c', 'a7410000-0000-4000-8000-000000000001', 'owner', 'Public Owner', 'created');

insert into public.collections
  (id, community_id, slug, name, category, participation_mode, audience_mode, amount_model, fixed_amount_kobo,
   status, visibility, fee_mode, created_by, published_by, published_at, archived_at)
values
  ('a7450000-0000-4000-8000-000000000001', 'a7420000-0000-4000-8000-00000000000a', 'listed-open', 'Listed Open',
   'dues', 'open', 'public', 'fixed', 500000, 'active', 'public', 'community_absorbs', 'a7410000-0000-4000-8000-000000000001', 'a7410000-0000-4000-8000-000000000001', now() - interval '2 days', null),
  ('a7450000-0000-4000-8000-000000000002', 'a7420000-0000-4000-8000-00000000000a', 'listed-ended', 'Listed Ended',
   'dues', 'open', 'public', 'fixed', 500000, 'closed', 'public', 'community_absorbs', 'a7410000-0000-4000-8000-000000000001', 'a7410000-0000-4000-8000-000000000001', now() - interval '1 day', null),
  ('a7450000-0000-4000-8000-000000000003', 'a7420000-0000-4000-8000-00000000000a', 'link-only', 'Link Only',
   'dues', 'open', 'public', 'fixed', 500000, 'active', 'unlisted', 'community_absorbs', 'a7410000-0000-4000-8000-000000000001', 'a7410000-0000-4000-8000-000000000001', now(), null),
  ('a7450000-0000-4000-8000-000000000004', 'a7420000-0000-4000-8000-00000000000a', 'members-only', 'Members Only',
   'dues', 'open', 'public', 'fixed', 500000, 'active', 'members_only', 'community_absorbs', 'a7410000-0000-4000-8000-000000000001', 'a7410000-0000-4000-8000-000000000001', now(), null),
  ('a7450000-0000-4000-8000-000000000005', 'a7420000-0000-4000-8000-00000000000a', 'listed-draft', 'Listed Draft',
   'dues', 'open', 'public', 'fixed', 500000, 'draft', 'public', 'community_absorbs', 'a7410000-0000-4000-8000-000000000001', null, null, null),
  ('a7450000-0000-4000-8000-000000000006', 'a7420000-0000-4000-8000-00000000000a', 'listed-archived', 'Listed Archived',
   'dues', 'open', 'public', 'fixed', 500000, 'archived', 'public', 'community_absorbs', 'a7410000-0000-4000-8000-000000000001', 'a7410000-0000-4000-8000-000000000001', now() - interval '9 days', now()),
  ('a7450000-0000-4000-8000-000000000007', 'a7420000-0000-4000-8000-00000000000b', 'quiet-listed', 'Quiet Listed',
   'dues', 'open', 'public', 'fixed', 500000, 'active', 'public', 'community_absorbs', 'a7410000-0000-4000-8000-000000000001', 'a7410000-0000-4000-8000-000000000001', now(), null);

create temp table tmp_ledger_before on commit drop as
  select (select count(*) from public.ledger_journals) as journals, (select count(*) from public.ledger_entries) as entries;
grant select on tmp_ledger_before to authenticated, anon;

create function pg_temp.as_user(p_n integer) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    format('{"sub":"a7410000-0000-4000-8000-00000000000%s","role":"authenticated"}', p_n), true);
end;
$$;
create function pg_temp.avatar(p_user integer, p_name text) returns text language sql as $$
  select 'http://127.0.0.1:54321/storage/v1/object/public/profile-avatars/a7410000-0000-4000-8000-00000000000'
         || p_user || '/' || p_name $$;

-- ── Before publishing ───────────────────────────────────────────────────────
set local role anon;
select is((select count(*)::int from app.get_public_community('public-74')), 0,
  'an unpublished community has no public page');
select is((select count(*)::int from app.get_public_community_collections('public-74')), 0,
  'and lists no collections, even listed ones');

-- ── Who may publish ─────────────────────────────────────────────────────────
select throws_ok($$ select app.set_community_public_page('a7420000-0000-4000-8000-00000000000a', true, false) $$,
  '42501', null, 'anon cannot publish a page');

set local role authenticated;
select pg_temp.as_user(2);
select throws_ok($$ select app.set_community_public_page('a7420000-0000-4000-8000-00000000000a', true, false) $$,
  '42501', 'FORBIDDEN: only the community owner can publish its public page', 'an admin officer cannot publish (owner only)');
select pg_temp.as_user(9);
select throws_ok($$ select app.set_community_public_page('a7420000-0000-4000-8000-00000000000a', true, false) $$,
  '42501', 'FORBIDDEN: only the community owner can publish its public page', 'an outsider cannot publish');
select throws_ok($$ select app.set_community_public_page('a7420000-0000-4000-8000-0000000000ff', true, false) $$,
  '42501', 'FORBIDDEN: only the community owner can publish its public page', 'an unknown community is refused the same way');

select pg_temp.as_user(1);
select throws_ok($$ select app.set_community_public_page('a7420000-0000-4000-8000-00000000000c', true, false) $$,
  'P0001', 'NOT_ALLOWED: a personal workspace has no public community page', 'a personal workspace cannot publish');
select lives_ok($$ select app.set_community_public_page('a7420000-0000-4000-8000-00000000000a', true, false) $$,
  'the owner publishes the page');

reset role;
select isnt((select public_page_published_at from public.communities where id = 'a7420000-0000-4000-8000-00000000000a'), null,
  'publication time is recorded');
select is((select count(*)::int from public.audit_logs
           where object_id = 'a7420000-0000-4000-8000-00000000000a' and action = 'community.set_public_page'), 1,
  'publishing is audited');

-- ── Public read ─────────────────────────────────────────────────────────────
set local role anon;
select is((select concat_ws('|', name, type, description, location_city, verification_status,
                            coalesce(contact_email, 'hidden'), coalesce(contact_phone_e164, 'hidden'))
           from app.get_public_community('public-74')),
  'Public Seventy Four|social_group|We meet monthly.|Lagos|unverified|hidden|hidden',
  'anon sees the identity fields and the real (unverified) status; contact hidden by default');
select is((select count(*)::int from app.get_public_community('PUBLIC-74')), 1,
  'the slug is matched case-insensitively, as URLs are typed');
select is((select string_agg(slug || ':' || status, ',') from app.get_public_community_collections('public-74')),
  'listed-open:active,listed-ended:closed',
  'only listed (public) collections appear, open first; link-only, members-only, draft and archived never do');
select is((select count(*)::int from app.get_public_community('quiet-74')), 0,
  'another community of the same owner stays unpublished');
select is((select count(*)::int from app.get_public_community_collections('quiet-74')), 0,
  'and its listed collection is not exposed through the community page');
select is((select count(*)::int from app.get_public_community('personal-74')), 0, 'a personal workspace never has a page');
select throws_ok($$ select count(*) from public.communities $$, '42501', null,
  'anon still cannot read the communities table directly');

-- Link-only collection pages keep working exactly as before (D-H).
select is((select count(*)::int from app.get_public_collection('public-74', 'link-only')), 1,
  'a link-only collection is still payable by its direct link');
select is((select count(*)::int from app.get_public_collection('public-74', 'members-only')), 0,
  'a members-only collection is still not served by the public collection read');

-- ── Contact switch, unpublish ───────────────────────────────────────────────
set local role authenticated;
select pg_temp.as_user(1);
select lives_ok($$ select app.set_community_public_page('a7420000-0000-4000-8000-00000000000a', true, true) $$,
  'the owner turns contact details on');
set local role anon;
select is((select contact_email from app.get_public_community('public-74')), 'hello@public74.example.test',
  'contact email is shown only after the owner chose to');

set local role authenticated;
select pg_temp.as_user(1);
select lives_ok($$ select app.set_community_public_page('a7420000-0000-4000-8000-00000000000a', false, true) $$,
  'the owner unpublishes');
set local role anon;
select is((select count(*)::int from app.get_public_community('public-74')), 0, 'an unpublished page is gone again');

-- ── Profile photo ───────────────────────────────────────────────────────────
select throws_ok($$ select app.set_my_avatar(pg_temp.avatar(1, '11111111-1111-4111-8111-111111111111.png')) $$,
  '42501', null, 'anon cannot set a profile photo');

set local role authenticated;
select pg_temp.as_user(1);
select is(app.set_my_avatar(pg_temp.avatar(1, '11111111-1111-4111-8111-111111111111.png')), null,
  'a first photo in the caller''s own folder is accepted (no previous photo)');
select is(app.set_my_avatar(pg_temp.avatar(1, '22222222-2222-4222-8222-222222222222.webp')),
  pg_temp.avatar(1, '11111111-1111-4111-8111-111111111111.png'),
  'replacing it returns the previous URL, so the server can delete that object');
select throws_ok($$ select app.set_my_avatar(pg_temp.avatar(2, '33333333-3333-4333-8333-333333333333.png')) $$,
  'P0001', 'INVALID_IMAGE: a profile photo must be an image uploaded to your own profile',
  'a photo in another user''s folder is refused');
select throws_ok($$ select app.set_my_avatar('https://evil.example/storage/v1/object/public/collection-covers/a7410000-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.png') $$,
  'P0001', 'INVALID_IMAGE: a profile photo must be an image uploaded to your own profile',
  'a URL in another bucket is refused');
select throws_ok($$ select app.set_my_avatar(pg_temp.avatar(1, '../a7410000-0000-4000-8000-000000000002/x.png')) $$,
  'P0001', 'INVALID_IMAGE: a profile photo must be an image uploaded to your own profile',
  'a path that climbs out of the caller''s folder is refused');
select is(app.set_my_avatar(null), pg_temp.avatar(1, '22222222-2222-4222-8222-222222222222.webp'),
  'clearing returns the photo to delete');

reset role;
select is((select avatar_url from public.users where id = 'a7410000-0000-4000-8000-000000000001'), null,
  'and the profile no longer points at it');
select is((select count(*)::int from public.audit_logs
           where actor_user_id = 'a7410000-0000-4000-8000-000000000001' and action in ('user.set_avatar', 'user.remove_avatar')), 3,
  'every photo change is audited (two sets, one removal)');
select is((select concat_ws('|', public, file_size_limit, array_to_string(allowed_mime_types, ','))
           from storage.buckets where id = 'profile-avatars'),
  't|2097152|image/jpeg,image/png,image/webp',
  'the avatar bucket is public, 2 MiB, three image types');
select is((select count(*)::int from pg_policies where schemaname = 'storage'
           and (coalesce(qual, '') || coalesce(with_check, '')) like '%profile-avatars%'), 0,
  'no storage policy mentions the avatar bucket: nobody can list it or write to it from a browser');

-- ── No money moved ──────────────────────────────────────────────────────────
select ok((select journals = (select count(*) from public.ledger_journals)
             and entries = (select count(*) from public.ledger_entries) from tmp_ledger_before),
  'nothing here wrote to the ledger');

select * from finish();
rollback;
