-- ─────────────────────────────────────────────────────────────────────────────
-- 60 — Organiser payment reminders (20261117100500, Phase 6)
--
--   · only a member-audience, one-time, active collection can be reminded
--   · eligible = in the audience, not paid, not exempt, reachable
--     (linked account → in-app; or a usable roll email not opted out)
--   · reminder.send required; a viewer sees the roster but cannot send
--   · one batch per click, idempotent per key, 24h cooldown per member,
--     one collection.remind_unpaid audit row that names the batch
--   · history is append-only; clients never read the tables directly
--   · the worker's recipient list re-checks at send time: paid since → skipped,
--     community notice missing → skipped, linked account → in-app
--   · the payment / targeted_reminder email cell is default-on + notice
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(33);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('a6010000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@remind.example.test',  now()),
  ('a6010000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'viewer@remind.example.test', now()),
  ('a6010000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'linked@remind.example.test', now());
insert into public.users (id, full_name, email) values
  ('a6010000-0000-4000-8000-000000000001', 'Remind Owner',  'owner@remind.example.test'),
  ('a6010000-0000-4000-8000-000000000002', 'Remind Viewer', 'viewer@remind.example.test'),
  ('a6010000-0000-4000-8000-000000000003', 'Linked Lola',   'linked@remind.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a6020000-0000-4000-8000-00000000000a', 'remind-tests', 'Remind Tests', 'social_group', false, 'a6010000-0000-4000-8000-000000000001');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason, scope) values
  ('a6020000-0000-4000-8000-00000000000a', 'a6010000-0000-4000-8000-000000000001', 'owner',  'Remind Owner',  'created', null),
  ('a6020000-0000-4000-8000-00000000000a', 'a6010000-0000-4000-8000-000000000002', 'viewer', 'Remind Viewer', 'invited', null);

insert into public.collections
  (id, community_id, slug, name, category, participation_mode, audience_mode, amount_model, fixed_amount_kobo,
   status, visibility, fee_mode, created_by)
values
  ('a6050000-0000-4000-8000-000000000001', 'a6020000-0000-4000-8000-00000000000a', 'levy', 'Levy',
   'dues', 'managed', 'all_members', 'fixed', 500000, 'active', 'unlisted', 'community_absorbs', 'a6010000-0000-4000-8000-000000000001'),
  ('a6050000-0000-4000-8000-000000000002', 'a6020000-0000-4000-8000-00000000000a', 'open-link', 'Open Link',
   'dues', 'open', 'public', 'fixed', 500000, 'active', 'unlisted', 'community_absorbs', 'a6010000-0000-4000-8000-000000000001'),
  ('a6050000-0000-4000-8000-000000000003', 'a6020000-0000-4000-8000-00000000000a', 'paused-levy', 'Paused Levy',
   'dues', 'managed', 'all_members', 'fixed', 500000, 'paused', 'unlisted', 'community_absorbs', 'a6010000-0000-4000-8000-000000000001');

insert into public.members (id, community_id, full_name, email, phone_e164, member_code, status, joined_via, user_id, claimed_at) values
  ('a6030000-0000-4000-8000-000000000001', 'a6020000-0000-4000-8000-00000000000a', 'Ade Paid',     'ade@remind.example.test',  '+2348000006001',            'R1', 'active', 'manual', null, null),
  ('a6030000-0000-4000-8000-000000000002', 'a6020000-0000-4000-8000-00000000000a', 'Bisi Unpaid',  'bisi@remind.example.test', '+2348000006002',            'R2', 'active', 'manual', null, null),
  ('a6030000-0000-4000-8000-000000000003', 'a6020000-0000-4000-8000-00000000000a', 'Chidi Phone',  null,                       '+2348000006003', 'R3', 'active', 'manual', null, null),
  ('a6030000-0000-4000-8000-000000000004', 'a6020000-0000-4000-8000-00000000000a', 'Dayo Optout',  'dayo@remind.example.test', '+2348000006004',            'R4', 'active', 'manual', null, null),
  ('a6030000-0000-4000-8000-000000000005', 'a6020000-0000-4000-8000-00000000000a', 'Linked Lola',  null,                       '+2348000006005',            'R5', 'active', 'manual', 'a6010000-0000-4000-8000-000000000003', now());

insert into public.notification_preferences (community_id, member_id, reminders_enabled) values
  ('a6020000-0000-4000-8000-00000000000a', 'a6030000-0000-4000-8000-000000000004', false);

create function pg_temp.pay(p_member uuid, p_ref integer) returns void language plpgsql as $$
declare
  v_attempt uuid;
  v_ref text := 'KLK-' || lpad(p_ref::text, 26, '0');
begin
  select attempt_id into v_attempt from app.create_payment_attempt(
    'a6050000-0000-4000-8000-000000000001', 'checkout-key-remind-' || p_ref, v_ref, 'fake', p_member,
    'Payer ' || p_ref, 'payer' || p_ref || '@remind.example.test', '+2348000000060', '{}'::jsonb, '{}'::text[],
    null, null, 500000, 2500, 7500, 0, 10000, 500000, 490000, 5000, 'community_absorbs', '2026-11-founder');
  perform app.record_provider_transaction(
    v_ref, 'fake', 'FAKE_TXN_' || p_ref, v_ref, 'succeeded', 'succeeded',
    500000, 'NGN', null, now(), 'card', null, '{"__fake": true}'::jsonb);
  perform app.complete_payment_capture(v_attempt);
end;
$$;
select pg_temp.pay('a6030000-0000-4000-8000-000000000001', 6001) is not null;

create temporary table tmp_b (label text primary key, id uuid);
grant all on tmp_b to authenticated;


-- ── Policy cell ─────────────────────────────────────────────────────────────

select is((select requirement || ':' || detail from app.communication_requirement('payment', 'email', 'targeted_reminder')),
  'default_on:community_notice', 'a targeted payment reminder by email is default-on and needs the community notice');
select is((select requirement || ':' || detail from app.communication_requirement('payment', 'sms', 'targeted_reminder')),
  'disabled:channel_disabled', 'SMS stays off');


-- ── What the organiser sees ─────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"a6010000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(
  (select supported || ':' || can_send || ':' || eligible_count || ':' || paid_count || ':' || unpaid_count || ':' || remindable_now_count
   from app.payment_reminder_summary('a6050000-0000-4000-8000-000000000001')),
  'true:true:5:1:4:2',
  'five in the audience, one paid, four unpaid, two reachable now (a roll email, a linked account)');

select is(
  (select string_agg(member_code || '=' || coalesce(blocked_reason, 'ok'), ',' order by member_code)
   from app.payment_reminder_roster('a6050000-0000-4000-8000-000000000001', 'unpaid', null, 50, 0)),
  'R2=ok,R3=no_contact,R4=opted_out,R5=ok',
  'the unpaid roster says why each member can or cannot be reminded (reminders switched off counts as opted out)');
select is(
  (select string_agg(member_code || '=' || blocked_reason, ',')
   from app.payment_reminder_roster('a6050000-0000-4000-8000-000000000001', 'paid', null, 50, 0)),
  'R1=paid', 'the paid filter shows who has paid');
select is(
  (select member_code || ':' || total_count from app.payment_reminder_roster('a6050000-0000-4000-8000-000000000001', 'all', 'bisi', 50, 0)),
  'R2:1', 'search by name');
select throws_ok($$ select * from app.payment_reminder_roster('a6050000-0000-4000-8000-000000000001', 'all', null, 500, 0) $$,
  '22023', null, 'a page is at most 200 rows');


-- ── Who may send ────────────────────────────────────────────────────────────

set local request.jwt.claims = '{"sub":"a6010000-0000-4000-8000-000000000002","role":"authenticated"}';
select is((select can_send from app.payment_reminder_summary('a6050000-0000-4000-8000-000000000001')), false,
  'a viewer reads the summary but cannot send');
select throws_ok($$ select * from app.send_payment_reminders('a6050000-0000-4000-8000-000000000001',
                    array['a6030000-0000-4000-8000-000000000002']::uuid[], 'viewer-send-key') $$,
  '42501', null, 'a viewer (no reminder.send) is refused');


-- ── Sending ─────────────────────────────────────────────────────────────────

set local request.jwt.claims = '{"sub":"a6010000-0000-4000-8000-000000000001","role":"authenticated"}';

select throws_ok($$ select * from app.send_payment_reminders('a6050000-0000-4000-8000-000000000001', '{}'::uuid[], 'empty-send-key') $$,
  '22023', null, 'an empty selection is refused');
select throws_ok($$ select * from app.send_payment_reminders('a6050000-0000-4000-8000-000000000001',
                    (select array_agg(gen_random_uuid()) from generate_series(1, 501)), 'too-many-key') $$,
  '22023', null, 'more than 500 members in one send is refused');
select throws_like($$ select * from app.send_payment_reminders('a6050000-0000-4000-8000-000000000002',
                      array['a6030000-0000-4000-8000-000000000002']::uuid[], 'open-link-key') $$,
  'REMINDERS_NOT_SUPPORTED:%', 'an open-link collection has no member list to remind');
select is((select supported || ':' || unsupported_reason from app.payment_reminder_summary('a6050000-0000-4000-8000-000000000002')),
  'false:public_collection', 'and its summary says so');
select throws_like($$ select * from app.send_payment_reminders('a6050000-0000-4000-8000-000000000003',
                      array['a6030000-0000-4000-8000-000000000002']::uuid[], 'paused-levy-key') $$,
  'COLLECTION_NOT_ACTIVE:%', 'a paused collection cannot be reminded');

insert into tmp_b select 'b1', batch_id from app.send_payment_reminders('a6050000-0000-4000-8000-000000000001',
  array['a6030000-0000-4000-8000-000000000001', 'a6030000-0000-4000-8000-000000000002', 'a6030000-0000-4000-8000-000000000003',
        'a6030000-0000-4000-8000-000000000004', 'a6030000-0000-4000-8000-000000000005', 'a6030000-0000-4000-8000-0000000000ff']::uuid[],
  'bulk-send-key-1');

reset role;
select is(
  (select member_count || ':' || (audit_log_id is not null) from public.payment_reminder_batches where id = (select id from tmp_b where label = 'b1')),
  '2:true', 'one batch of two: the paid, unreachable and unknown members were left out');
select is(
  (select string_agg(m.member_code, ',' order by m.member_code) from public.payment_reminders r join public.members m on m.id = r.member_id
   where r.batch_id = (select id from tmp_b where label = 'b1')),
  'R2,R5', 'Bisi (roll email) and Lola (linked account) are reminded');
select is(
  (select (after_state ->> 'reminder_batch_id')::uuid from public.audit_logs a
   where a.id = (select audit_log_id from public.payment_reminder_batches where id = (select id from tmp_b where label = 'b1'))
     and a.action = 'collection.remind_unpaid'),
  (select id from tmp_b where label = 'b1'), 'one collection.remind_unpaid audit row names the batch (it queues delivery)');

set local role authenticated;
set local request.jwt.claims = '{"sub":"a6010000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(
  (select sent_count || ':' || skipped_paid || ':' || skipped_cooldown || ':' || skipped_ineligible || ':' || skipped_unreachable || ':' || reused
   from app.send_payment_reminders('a6050000-0000-4000-8000-000000000001',
     array['a6030000-0000-4000-8000-000000000002']::uuid[], 'bulk-send-key-1')),
  '2:0:0:0:0:true', 'a replayed click returns the first batch');

select is(
  (select coalesce(batch_id::text, 'none') || ':' || sent_count || ':' || skipped_paid || ':' || skipped_cooldown || ':' || skipped_unreachable
   from app.send_payment_reminders('a6050000-0000-4000-8000-000000000001',
     array['a6030000-0000-4000-8000-000000000001', 'a6030000-0000-4000-8000-000000000002', 'a6030000-0000-4000-8000-000000000003',
           'a6030000-0000-4000-8000-000000000005']::uuid[], 'bulk-send-key-2')),
  'none:0:1:2:1', 'within 24 hours nobody is reminded twice; nothing is recorded when nothing is sent');

select is(
  (select string_agg(member_code || '=' || blocked_reason || '/' || reminder_count, ',' order by member_code)
   from app.payment_reminder_roster('a6050000-0000-4000-8000-000000000001', 'reminded', null, 50, 0)),
  'R2=cooldown/1,R5=cooldown/1', 'the reminded filter shows the history and the cooldown');
select is(
  (select reminded_count || ':' || remindable_now_count || ':' || reminders_sent || ':' || (last_sent_at is not null)
   from app.payment_reminder_summary('a6050000-0000-4000-8000-000000000001')),
  '2:0:2:true', 'summary: two reminded, none remindable now, two reminders sent');

select throws_ok($$ select count(*) from public.payment_reminders $$, '42501', null, 'clients cannot read reminder rows directly');
select throws_ok($$ select count(*) from public.payment_reminder_batches $$, '42501', null, 'nor batches');
select throws_ok(format($$ select * from app.payment_reminder_batch_recipients(%L) $$, (select id from tmp_b where label = 'b1')),
  '42501', null, 'the worker''s recipient list is not callable by clients');


-- ── History is append-only ──────────────────────────────────────────────────

reset role;
select throws_ok(format($$ delete from public.payment_reminders where batch_id = %L $$, (select id from tmp_b where label = 'b1')),
  'P0001', null, 'a reminder cannot be deleted');
select throws_ok(format($$ update public.payment_reminder_batches set member_count = 1 where id = %L $$, (select id from tmp_b where label = 'b1')),
  'P0001', null, 'a batch cannot be edited');


-- ── Worker re-check at send time ────────────────────────────────────────────

select is(
  (select string_agg(coalesce(skip_reason, 'send') || '/' || in_app, ',' order by member_id)
   from app.payment_reminder_batch_recipients((select id from tmp_b where label = 'b1'))),
  'community_notice_missing/false,community_notice_missing/true',
  'no community notice yet: no email to anyone; the linked account still gets in-app');

set local role authenticated;
set local request.jwt.claims = '{"sub":"a6010000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$ select app.attest_community_communication_notice('a6020000-0000-4000-8000-00000000000a', 'community-notice-v1') $$,
  'the owner records the community notice');
reset role;

select is(
  (select string_agg(eligible || '/' || address || '/' || assurance, ',' order by member_id)
   from app.payment_reminder_batch_recipients((select id from tmp_b where label = 'b1'))),
  'true/bisi@remind.example.test/unverified_supplied,true/linked@remind.example.test/verified_account',
  'with the notice: the roll email and the account email both qualify, each with its assurance');

-- Bisi pays after the click but before the worker runs.
select pg_temp.pay('a6030000-0000-4000-8000-000000000002', 6002) is not null;
select is(
  (select skip_reason || '/' || in_app from app.payment_reminder_batch_recipients((select id from tmp_b where label = 'b1'))
   where member_id = 'a6030000-0000-4000-8000-000000000002'),
  'already_paid/false', 'a member who paid since the click is not reminded on any channel');

insert into public.notification_preferences (community_id, member_id, email_enabled) values
  ('a6020000-0000-4000-8000-00000000000a', 'a6030000-0000-4000-8000-000000000005', false);
select is(
  (select skip_reason || '/' || in_app from app.payment_reminder_batch_recipients((select id from tmp_b where label = 'b1'))
   where member_id = 'a6030000-0000-4000-8000-000000000005'),
  'opted_out/true', 'an email opt-out stops the email, not the in-app notice');

select is(
  (select count(*)::integer from app.payment_reminder_batch_recipients(gen_random_uuid())), 0,
  'an unknown batch has no recipients');

set local role authenticated;
set local request.jwt.claims = '{"sub":"a6010000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select paid_count || ':' || unpaid_count from app.payment_reminder_summary('a6050000-0000-4000-8000-000000000001')),
  '2:3', 'the summary follows payments live');

select * from finish();
rollback;
