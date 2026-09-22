#!/usr/bin/env node
/**
 * Two requests at once must never be handed the same reference (M7.6 part AB).
 *
 * WHY THIS IS NOT A pgTAP TEST. pgTAP runs in one session inside one
 * transaction. A counter that is safe under concurrency and a counter that is
 * not behave identically there — `select count(*) + 1` passes every
 * single-session test ever written, and then hands two people the same ticket
 * number on the evening the collection is shared in a WhatsApp group. The
 * only way to test it is to open real connections and let them race.
 *
 * WHAT IT DOES
 *   1. builds a collection with references switched on, and N members
 *   2. assigns all N in one call, WITHOUT references, so there is a roll
 *      waiting with nothing issued against it
 *   3. opens N connections and fires app.issue_contributor_reference at the
 *      same moment, with a barrier so they genuinely overlap
 *   4. asserts N references, all distinct, all matching the format, and a
 *      counter that has moved by exactly N
 *   5. fires the same N calls AGAIN and asserts nothing new is issued, which
 *      is the idempotence claim under concurrency rather than in sequence
 *   6. removes everything it made
 *
 * Usage: node scripts/verify/reference-concurrency.mjs [--writers 24]
 *
 * It talks to the LOCAL stack only, through the same connection string the
 * app uses, and it creates and drops its own fixtures. It never touches data
 * it did not create.
 */

import postgres from "postgres";
import process from "node:process";

const WRITERS = Number(process.argv[process.argv.indexOf("--writers") + 1]) || 24;
const URL_ = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// Fixed ids so a crashed run can be cleaned up by the next one.
const OWNER = "cafe0000-0000-4000-8000-00000000c001";
const COMMUNITY = "cafe0000-0000-4000-8000-00000000c002";
const TAG = "concurrency-test-references";

const sql = postgres(URL_, { max: WRITERS + 4, onnotice: () => {} });

let failures = 0;
function check(condition, description, detail) {
  if (condition) {
    console.log(`  ok   ${description}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${description}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

async function cleanup() {
  // Order matters: references and obligations both refuse deletion through
  // their own guards, so the triggers come off first. This is fixture
  // teardown against rows this script created, in a local database.
  await sql.unsafe(`
    alter table public.contributor_references disable trigger contributor_references_immutable;
    alter table public.obligations disable trigger obligations_delete_guard;
    alter table public.collections disable trigger collections_delete_guard;
    alter table public.audit_logs disable trigger audit_logs_no_delete;
    alter table public.audit_logs disable trigger audit_logs_no_update;

    -- Everything under EVERY community this owner created, not only the one
    -- with the fixed id: creating the user also creates their personal
    -- community (user bootstrap), and leaving it behind is what makes the
    -- owner undeletable.
    create temporary table tmp_doomed on commit drop as
      select id from public.communities where created_by = '${OWNER}';

    -- Audit rows go first. audit_logs.officer_term_id and .actor_user_id are
    -- ON DELETE SET NULL, and an UPDATE of an audit row is refused outright
    -- (AUD-01) — so deleting an officer term while its audit rows exist fails
    -- inside the foreign key rather than in anything this script wrote.
    delete from public.audit_logs where community_id in (select id from tmp_doomed);
    delete from public.contributor_references where community_id in (select id from tmp_doomed);
    delete from public.collection_code_sequences where collection_id in
      (select id from public.collections where community_id in (select id from tmp_doomed));
    delete from public.obligations where community_id in (select id from tmp_doomed);
    delete from public.collection_code_settings where community_id in (select id from tmp_doomed);
    delete from public.collection_audience_groups where community_id in (select id from tmp_doomed);
    delete from public.collection_tiers where community_id in (select id from tmp_doomed);
    delete from public.collections where community_id in (select id from tmp_doomed);
    delete from public.members where community_id in (select id from tmp_doomed);
    delete from public.officer_terms where community_id in (select id from tmp_doomed);
    delete from public.community_slug_history where community_id in (select id from tmp_doomed);
    delete from public.communities where id in (select id from tmp_doomed);
    delete from public.users where id = '${OWNER}';
    delete from auth.users where id = '${OWNER}';

    alter table public.audit_logs enable trigger audit_logs_no_update;
    alter table public.audit_logs enable trigger audit_logs_no_delete;
    alter table public.collections enable trigger collections_delete_guard;
    alter table public.obligations enable trigger obligations_delete_guard;
    alter table public.contributor_references enable trigger contributor_references_immutable;
  `);
}

async function main() {
  console.log(`Contributor references under ${WRITERS} simultaneous writers\n`);
  await cleanup();

  // ── Fixtures ─────────────────────────────────────────────────────────────
  await sql.unsafe(`
    insert into auth.users (id, instance_id, aud, role, email)
    values ('${OWNER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '${TAG}@example.test');
    -- A trigger on auth.users already creates the public row (user bootstrap),
    -- so this settles the name rather than inserting a second one.
    insert into public.users (id, full_name, email)
    values ('${OWNER}', 'Concurrency Owner', '${TAG}@example.test')
    on conflict (id) do update set full_name = excluded.full_name;
    insert into public.communities (id, slug, name, type, is_personal, created_by)
    values ('${COMMUNITY}', '${TAG}', 'CONCURRENCY_TEST_REFERENCES', 'social_group', false, '${OWNER}');
    insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason)
    values ('${COMMUNITY}', '${OWNER}', 'owner', 'Concurrency Owner', 'created');
  `);

  for (let index = 0; index < WRITERS; index += 1) {
    await sql`
      insert into public.members (community_id, full_name, phone_e164, member_code, status, joined_via)
      values (${COMMUNITY}, ${`Racer ${index + 1}`}, ${`+23480999${String(index).padStart(5, "0")}`},
              ${`RC/${String(index + 1).padStart(4, "0")}`}, 'active', 'manual')
    `;
  }

  const asOwner = async (run) =>
    sql.begin(async (tx) => {
      await tx`select set_config('role', 'authenticated', true)`;
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: OWNER, role: "authenticated" })}, true)`;
      return run(tx);
    });

  const [collection] = await asOwner(
    (tx) => tx`
      select app.create_collection(
        ${COMMUNITY}, 'Concurrency Dinner', 'event', 'managed', 'fixed',
        null, 'full_only', 'one_time', 500000
      ) as id`,
  );
  const collectionId = collection.id;

  // The roll first, with references OFF, so every one of them is issued by
  // the race rather than quietly during the assign.
  const memberIds = (await sql`select id from public.members where community_id = ${COMMUNITY} order by member_code`).map(
    (row) => row.id,
  );
  await asOwner((tx) => tx`select app.assign_obligations(${collectionId}, ${memberIds}, null, null)`);

  await asOwner(
    (tx) => tx`select app.set_collection_code_settings(${collectionId}, true, 'RACE', '-', 4::smallint, 1::bigint, 'sequential')`,
  );

  const obligationIds = (
    await sql`select id from public.obligations where collection_id = ${collectionId} order by created_at`
  ).map((row) => row.id);
  check(obligationIds.length === WRITERS, `the roll has ${WRITERS} people on it`, `got ${obligationIds.length}`);

  // ── The race ─────────────────────────────────────────────────────────────
  // A barrier so the calls genuinely overlap. Without it the first connection
  // finishes before the last one has been opened, and the test proves nothing.
  async function raceOnce() {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    const runs = obligationIds.map((obligationId) =>
      sql
        .begin(async (tx) => {
          await tx`select set_config('role', 'authenticated', true)`;
          await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: OWNER, role: "authenticated" })}, true)`;
          await gate;
          const [row] = await tx`select app.issue_contributor_reference(${obligationId}) as reference`;
          return row.reference;
        })
        .catch((error) => ({ error: String(error.message ?? error) })),
    );

    // Everything is connected and waiting. Go.
    await new Promise((resolve) => setTimeout(resolve, 150));
    release();
    return Promise.all(runs);
  }

  const first = await raceOnce();
  const errors = first.filter((result) => typeof result !== "string");
  check(errors.length === 0, "no request failed", errors.map((error) => error.error).join(" | "));

  const issued = first.filter((result) => typeof result === "string");
  const distinct = new Set(issued);
  check(
    distinct.size === issued.length,
    `all ${issued.length} references are distinct`,
    `${issued.length - distinct.size} collision(s): ${[...issued].filter((r, i, all) => all.indexOf(r) !== i).join(", ")}`,
  );

  const badFormat = issued.filter((reference) => !/^RACE-\d{4,}$/.test(reference));
  check(badFormat.length === 0, "every reference matches the configured format", badFormat.join(", "));

  const numbers = issued.map((reference) => Number(reference.split("-")[1])).sort((a, b) => a - b);
  check(
    numbers[0] === 1 && numbers.at(-1) === WRITERS,
    `the numbers issued are exactly 1..${WRITERS} with no gaps`,
    `got ${numbers[0]}..${numbers.at(-1)}`,
  );

  const [counter] = await sql`
    select next_number from public.collection_code_sequences
    where collection_id = ${collectionId} and tier_id is null`;
  check(
    Number(counter.next_number) === WRITERS + 1,
    `the counter moved by exactly ${WRITERS}`,
    `next_number is ${counter?.next_number}`,
  );

  // ── The same race again: nothing new ─────────────────────────────────────
  const second = await raceOnce();
  const secondIssued = second.filter((result) => typeof result === "string");
  check(
    secondIssued.length === issued.length && secondIssued.every((reference) => distinct.has(reference)),
    "asking again, all at once, returns the same references and issues none",
  );

  const [total] = await sql`
    select count(*)::int as count from public.contributor_references where collection_id = ${collectionId}`;
  check(total.count === WRITERS, `there are still exactly ${WRITERS} references`, `got ${total.count}`);

  await cleanup();

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
  await sql.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  try {
    await cleanup();
  } catch {
    // The run already failed; a teardown failure on top of it is noise.
  }
  await sql.end();
  process.exit(1);
});
