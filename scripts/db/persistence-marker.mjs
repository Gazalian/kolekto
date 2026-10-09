#!/usr/bin/env node
/**
 * Marker data for proving the local database actually persists.
 *
 * The question this answers is not "does Postgres store rows" — it is "which
 * of the things a developer does every day quietly destroys their work". The
 * only honest way to find out is to write a row that could not appear by
 * accident, perform one lifecycle operation, and look again.
 *
 *   node scripts/db/persistence-marker.mjs create   write the marker
 *   node scripts/db/persistence-marker.mjs check    exit 0 if it is all there
 *   node scripts/db/persistence-marker.mjs drop     remove it
 *
 * `check` exits non-zero and names what is missing, so it can sit between two
 * lifecycle operations in a script and fail the run rather than print a warning
 * nobody reads.
 */

import { execFileSync } from "node:child_process";
import process from "node:process";

const CONTAINER = process.env.KOLEKTO_DB_CONTAINER ?? "supabase_db_kolekto";
const COMMUNITY = "beef0000-0000-4000-8000-00000000d001";
const GROUP = "beef0000-0000-4000-8000-00000000d002";
const MEMBER = "beef0000-0000-4000-8000-00000000d003";
const DEFINITION = "beef0000-0000-4000-8000-00000000d004";
const OWNER = "beef0000-0000-4000-8000-00000000d005";

function psql(sql) {
  return execFileSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-F", "|"],
    { input: sql, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
}

const CREATE = `
insert into auth.users (id, instance_id, aud, role, email)
values ('${OWNER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'persistence-test-001@example.test')
on conflict (id) do nothing;

insert into public.users (id, full_name, email)
values ('${OWNER}', 'Persistence Test Owner', 'persistence-test-001@example.test')
on conflict (id) do nothing;

insert into public.communities (id, slug, name, type, is_personal, created_by)
values ('${COMMUNITY}', 'persistence-test-001', 'PERSISTENCE_TEST_001', 'fellowship', false, '${OWNER}')
on conflict (id) do nothing;

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason)
select '${COMMUNITY}', '${OWNER}', 'owner', 'Persistence Test Owner', 'created'
where not exists (
  select 1 from public.officer_terms where community_id = '${COMMUNITY}' and user_id = '${OWNER}' and ended_at is null
);

insert into public.community_member_code_settings (community_id, prefix, padding, next_number)
values ('${COMMUNITY}', 'PT/', 4, 2)
on conflict (community_id) do nothing;

insert into public.member_attribute_definitions
  (id, community_id, key, label, type, required_at_join, is_unique, is_primary_identifier, sort_order)
values ('${DEFINITION}', '${COMMUNITY}', 'marker_code', 'Marker code', 'text', false, true, true, 0)
on conflict (id) do nothing;

insert into public.member_groups (id, community_id, name, sort_order)
values ('${GROUP}', '${COMMUNITY}', 'Persistence Group', 0)
on conflict (id) do nothing;

insert into public.members (id, community_id, full_name, phone_e164, member_code, status, joined_via)
values ('${MEMBER}', '${COMMUNITY}', 'Persistence Marker Member', '+2348099990001', 'PT/0001', 'active', 'manual')
on conflict (id) do nothing;

insert into public.member_group_memberships (member_id, group_id)
values ('${MEMBER}', '${GROUP}')
on conflict do nothing;

insert into public.member_attribute_values (member_id, definition_id, community_id, value_text, value_norm)
values ('${MEMBER}', '${DEFINITION}', '${COMMUNITY}', 'MARKER-001', 'marker-001')
on conflict (member_id, definition_id) do nothing;

-- This audit row names a watched action (member.create). It is a marker, not a person adding
-- a member, so it must not notify anyone: M13.2 P3 (decision record 10.7). The setting is
-- transaction-local, and psql runs each statement of piped input on its own unless they share
-- a transaction block, so the suppression and the audit write are wrapped in one.
begin;
select app.begin_notification_suppression('persistence marker');
select app.write_audit_log('${COMMUNITY}', 'system', null, 'member.create', 'member', '${MEMBER}');
commit;
`;

const CHECKS = [
  ["auth user", `select count(*) from auth.users where id = '${OWNER}'`],
  ["community", `select count(*) from public.communities where id = '${COMMUNITY}'`],
  ["officer term", `select count(*) from public.officer_terms where community_id = '${COMMUNITY}'`],
  ["member", `select count(*) from public.members where id = '${MEMBER}' and member_code = 'PT/0001'`],
  ["group", `select count(*) from public.member_groups where id = '${GROUP}'`],
  ["group membership", `select count(*) from public.member_group_memberships where member_id = '${MEMBER}'`],
  ["field definition", `select count(*) from public.member_attribute_definitions where id = '${DEFINITION}'`],
  ["attribute value", `select count(*) from public.member_attribute_values where member_id = '${MEMBER}' and value_norm = 'marker-001'`],
  ["code settings", `select count(*) from public.community_member_code_settings where community_id = '${COMMUNITY}'`],
  ["audit row", `select count(*) from public.audit_logs where community_id = '${COMMUNITY}'`],
];

const DROP = `
delete from public.audit_logs where community_id = '${COMMUNITY}';
delete from public.member_attribute_values where member_id = '${MEMBER}';
delete from public.member_group_memberships where member_id = '${MEMBER}';
delete from public.member_attribute_definitions where id = '${DEFINITION}';
delete from public.member_groups where id = '${GROUP}';
alter table public.members disable trigger members_delete_guard;
delete from public.members where id = '${MEMBER}';
alter table public.members enable trigger members_delete_guard;
delete from public.officer_terms where community_id = '${COMMUNITY}';
delete from public.community_member_code_settings where community_id = '${COMMUNITY}';
delete from public.communities where id = '${COMMUNITY}';
delete from public.users where id = '${OWNER}';
delete from auth.users where id = '${OWNER}';
`;

const command = process.argv[2] ?? "check";

try {
  if (command === "create") {
    psql(CREATE);
    console.log("Marker PERSISTENCE_TEST_001 written.");
  } else if (command === "drop") {
    psql(DROP);
    console.log("Marker removed.");
  } else {
    const missing = [];
    for (const [label, sql] of CHECKS) {
      const count = Number.parseInt(psql(sql).trim(), 10);
      if (!Number.isFinite(count) || count < 1) missing.push(label);
    }

    if (missing.length > 0) {
      console.error(`MARKER LOST — missing: ${missing.join(", ")}`);
      process.exit(1);
    }
    console.log("Marker intact: all 10 pieces present.");
  }
} catch (error) {
  console.error(command === "check" ? "MARKER CHECK FAILED" : `${command} failed`);
  console.error(error instanceof Error ? error.message.split("\n").slice(0, 4).join("\n") : error);
  process.exit(1);
}
