-- ─────────────────────────────────────────────────────────────────────────────
-- Local seed data
--
-- Synthetic, obviously fake, and never a copy of production (ADR 0007). Every
-- phone number is in Nigeria's 0800 test-ish range and every email is
-- @example.test, so nothing here can reach a real person if a job is
-- accidentally pointed at a seeded database.
--
-- Enough to exercise the shapes that matter: a personal community and a named
-- one, several officer roles, members with groups and attributes, a managed
-- dues collection with obligations, and a tiered event.
-- ─────────────────────────────────────────────────────────────────────────────

-- Supabase's local stack owns auth.users; seeding it directly is fine locally
-- and never runs against a cloud project.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data)
values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'aisha@example.test', '{"full_name":"Aisha Bello"}'),
  ('00000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'tunde@example.test', '{"full_name":"Tunde Adeyemi"}'),
  ('00000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ngozi@example.test', '{"full_name":"Ngozi Okonkwo"}')
on conflict (id) do nothing;

insert into public.users (id, full_name, phone_e164, email, identity_level) values
  ('00000000-0000-4000-8000-000000000001', 'Aisha Bello',   '+2348000000001', 'aisha@example.test', 'contact_verified'),
  ('00000000-0000-4000-8000-000000000002', 'Tunde Adeyemi', '+2348000000002', 'tunde@example.test', 'contact_verified'),
  ('00000000-0000-4000-8000-000000000003', 'Ngozi Okonkwo', '+2348000000003', 'ngozi@example.test', 'none')
on conflict (id) do nothing;

-- COM-01: every user gets a personal community. Seeded explicitly here; in the
-- application this happens at sign-up.
insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('10000000-0000-4000-8000-000000000001', 'aishas-collections', 'Aisha''s collections', 'personal', true,  '00000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002', 'csc-unilorin',       'Computer Science Students'' Association', 'university_association', false, '00000000-0000-4000-8000-000000000001');

insert into public.community_labels (community_id, key, label) values
  ('10000000-0000-4000-8000-000000000002', 'member_identifier', 'Matric number');

insert into public.leadership_terms (id, community_id, name, starts_on) values
  ('11000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', '2026/2027 Executive', '2026-09-01');

insert into public.officer_terms (community_id, user_id, role, title, leadership_term_id, actor_name_snapshot, start_reason) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'owner',     null,                  null,                                   'Aisha Bello',   'created'),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'owner',     'President',           '11000000-0000-4000-8000-000000000001', 'Aisha Bello',   'created'),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', 'treasurer', 'Financial Secretary', '11000000-0000-4000-8000-000000000001', 'Tunde Adeyemi', 'invited'),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', 'collector', 'Class Rep, 300L',     '11000000-0000-4000-8000-000000000001', 'Ngozi Okonkwo', 'invited');

insert into public.member_attribute_definitions (community_id, key, label, type, options, required_at_join, sort_order) values
  ('10000000-0000-4000-8000-000000000002', 'level',      'Level',      'single_select', array['100','200','300','400','500'], true, 1),
  ('10000000-0000-4000-8000-000000000002', 'department', 'Department', 'text',          null,                                false, 2);

insert into public.member_groups (id, community_id, name, pickable_at_join, sort_order) values
  ('12000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', '300 Level', true, 1),
  ('12000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '400 Level', true, 2);

insert into public.members (id, community_id, full_name, phone_e164, email, identifier, attributes, status, joined_via) values
  ('13000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'Chidi Eze',      '+2348000000011', 'chidi@example.test',  'CSC/2023/001', '{"level":"300","department":"Computer Science"}', 'active',    'invite_link'),
  ('13000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'Fatima Sani',    '+2348000000012', 'fatima@example.test', 'CSC/2023/002', '{"level":"300","department":"Computer Science"}', 'active',    'invite_link'),
  ('13000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'Emeka Nwosu',    '+2348000000013', null,                  'CSC/2022/044', '{"level":"400","department":"Computer Science"}', 'unclaimed', 'import');

insert into public.member_group_memberships (member_id, group_id) values
  ('13000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001'),
  ('13000000-0000-4000-8000-000000000002', '12000000-0000-4000-8000-000000000001'),
  ('13000000-0000-4000-8000-000000000003', '12000000-0000-4000-8000-000000000002');

-- A managed dues collection. ₦20,000 is 2,000,000 kobo (ADR 0003 — money is
-- always the integer, and the seed says so out loud).
insert into public.collections (id, community_id, slug, name, description, category,
                                participation_mode, amount_model, payment_plan, schedule,
                                fixed_amount_kobo, deadline_at, status, visibility,
                                codes_enabled, created_by, published_by, published_at) values
  ('14000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'dues-2026-2027',
   '2026/2027 Departmental Dues', 'Annual dues covering the departmental week, handbook and welfare fund.',
   'dues', 'managed', 'fixed', 'installments_allowed', 'one_time',
   2000000, '2026-12-15 23:59:00+01', 'active', 'unlisted',
   false, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', now());

insert into public.obligations (community_id, collection_id, member_id, expected_amount_kobo, due_at) values
  ('10000000-0000-4000-8000-000000000002', '14000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-000000000001', 2000000, '2026-12-15 23:59:00+01'),
  ('10000000-0000-4000-8000-000000000002', '14000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-000000000002', 2000000, '2026-12-15 23:59:00+01'),
  ('10000000-0000-4000-8000-000000000002', '14000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-000000000003', 2000000, '2026-12-15 23:59:00+01');

-- A tiered event. Note the tier names: deliberately similar, and now impossible
-- to duplicate (ADR 0010). These are the shapes that broke the old system.
insert into public.collections (id, community_id, slug, name, category,
                                participation_mode, amount_model, payment_plan, schedule,
                                status, visibility, codes_enabled, created_by, published_by, published_at) values
  ('14000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'dinner-night-2026',
   'Departmental Dinner Night', 'event', 'open', 'tiers', 'full_only', 'one_time',
   'active', 'public', true, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', now());

insert into public.collection_tiers (collection_id, community_id, name, description, price_kobo, quantity_limit, code_prefix, sort_order) values
  ('14000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'Regular',           'Dinner and programme',              1500000, 200, 'REG', 1),
  ('14000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'VIP',               'Front table, dinner and programme', 3000000,  40, 'VIP', 2),
  ('14000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'VIP — couple',      'Two VIP seats',                     5500000,  20, 'VIPC', 3);

insert into public.collection_code_settings (collection_id, community_id, prefix, style, per_unit) values
  ('14000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'DIN26', 'sequential', true);

insert into public.collection_fields (collection_id, community_id, key, label, type, options, required, sort_order) values
  ('14000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'meal', 'Meal preference', 'single_select', array['Jollof','Fried rice','Vegetarian'], true, 1);
