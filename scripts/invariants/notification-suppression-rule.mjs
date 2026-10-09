/**
 * notification-suppression-rule.mjs — invariant 7 (M13.2 P3).
 *
 * THE RULE. A migration or a maintenance script that EXECUTES an audited write of a
 * watched action must also call app.begin_notification_suppression(...). Otherwise a
 * repair, a backfill or a marker would notify real people (decision record 10.7,
 * inventory path 12-13).
 *
 * WHAT "EXECUTES" MEANS. Migrations are full of function DEFINITIONS that call
 * write_audit_log; those run only when a user acts and are the product. They are masked
 * out. What is checked is code that runs when the file runs: top-level statements, DO
 * blocks, and the SQL strings inside maintenance scripts.
 *
 * WHAT "A WRITE OF A WATCHED ACTION" MEANS (any of):
 *   · a call of write_audit_log( with a watched action literal within three lines;
 *   · an INSERT into audit_logs with a watched action literal within six lines;
 *   · a call of an audited domain function that writes a watched action
 *     (create_member, approve_pending_member, reject_pending_member, redeem_invite_link,
 *     end_officer_term, accept_officer_invitation, transition_collection_status).
 *
 * WHERE THE WATCHED LIST COMES FROM. The trigger migration itself (c_watched in the
 * enqueue function), so there is one source of truth; it is cross-checked against the
 * worker's WATCHED_ACTIONS so the two cannot drift apart silently.
 *
 * SCOPE. scripts/**, supabase/seed.sql, supabase/migrations/**. Not supabase/tests (they
 * run in rolled-back transactions) and not application code (apps/**, packages/**), whose
 * audited calls ARE the product, running under the caller's role.
 *
 * The module carries a self-test (selfTest) that the runner executes every time, so the
 * scanner cannot quietly stop detecting.
 */

const DOMAIN_FUNCTIONS = [
  "create_member", "approve_pending_member", "reject_pending_member", "redeem_invite_link",
  "end_officer_term", "accept_officer_invitation", "transition_collection_status",
];

const HELPER = /begin_notification_suppression/;

/** Replace comments with spaces, preserving newlines so line numbers stay true. */
function maskComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      // whole-line comments in SQL (--), JS (//, *), shell (#)
      if (/^(--|\/\/|\*|#)/.test(trimmed)) return " ".repeat(line.length);
      // trailing SQL comment
      return line.replace(/--.*$/, (m) => " ".repeat(m.length));
    })
    .join("\n");
}

/** Blank out the bodies of function/procedure definitions: they run when a user acts, not when the file runs. */
function maskDefinitionBodies(text) {
  const tag = /\$([A-Za-z_]*)\$/g;
  const marks = [];
  let m;
  while ((m = tag.exec(text)) !== null) marks.push({ index: m.index, end: m.index + m[0].length, tag: m[0] });

  let out = text;
  const used = new Set();
  for (let i = 0; i < marks.length; i += 1) {
    if (used.has(i)) continue;
    const open = marks[i];
    const closeIdx = marks.findIndex((x, j) => j > i && x.tag === open.tag);
    if (closeIdx === -1) continue;
    const close = marks[closeIdx];
    used.add(closeIdx);
    // the statement head: from the previous semicolon up to the opening tag
    const before = text.slice(0, open.index);
    const head = before.slice(before.lastIndexOf(";") + 1);
    if (/\b(create|alter)\b[\s\S]*\b(function|procedure)\b/i.test(head)) {
      const body = out.slice(open.end, close.index).replace(/[^\n]/g, " ");
      out = out.slice(0, open.end) + body + out.slice(close.index);
    }
  }
  return out;
}

/**
 * Find executable writes of a watched action that lack the suppression helper.
 * @param {string} text    file contents
 * @param {"sql"|"script"} kind
 * @param {readonly string[]} watched
 * @returns {{line:number, text:string}[]} offending lines (empty when the file is fine)
 */
export function findUnsuppressedWatchedWrites(text, kind, watched) {
  let body = maskComments(text);
  if (kind === "sql") body = maskDefinitionBodies(body);
  if (HELPER.test(body)) return []; // the file suppresses; it is allowed to write
  const lines = body.split("\n");
  const original = text.split("\n");

  const actionLiteral = new RegExp(`'(?:${watched.map((a) => a.replace(/[.]/g, "\\.")).join("|")})'`);
  const found = [];

  const near = (index, radius) => {
    const slice = lines.slice(Math.max(0, index - radius), index + radius + 1).join("\n");
    return actionLiteral.test(slice);
  };

  // DDL that merely NAMES an audited function (grant / revoke / comment / create / drop / alter)
  // is not a call to it.
  const DDL = /^\s*(grant|revoke|comment\s+on|drop|alter|create(\s+or\s+replace)?)\b/i;

  lines.forEach((line, index) => {
    if (DDL.test(line)) return;
    let hit = false;
    if (/write_audit_log\s*\(/i.test(line) && near(index, 3)) hit = true;
    else if (/insert\s+into\s+(?:public\.)?audit_logs/i.test(line) && near(index, 6)) hit = true;
    else if (new RegExp(`\\bapp\\.(?:${DOMAIN_FUNCTIONS.join("|")})\\s*\\(`, "i").test(line)) hit = true;
    if (hit) found.push({ line: index + 1, text: (original[index] ?? "").trim() });
  });
  return found;
}

/** Pull c_watched out of the trigger migration text. Returns null if it cannot be found. */
export function extractTriggerWatched(sql) {
  const m = /c_watched\s+constant\s+text\[\]\s*:=\s*array\[([\s\S]*?)\]/i.exec(sql);
  if (!m) return null;
  return [...m[1].matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((x) => x[1]);
}

/** Pull WATCHED_ACTIONS out of the worker's rules module text. Returns null if it cannot be found. */
export function extractWorkerWatched(ts) {
  const m = /WATCHED_ACTIONS\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(ts);
  if (!m) return null;
  return [...m[1].matchAll(/"([a-z_]+\.[a-z_]+)"/g)].map((x) => x[1]);
}

/** The scanner proves itself on fixed fixtures every run. Returns a list of failure messages. */
export function selfTest() {
  const W = ["member.create", "member.approve_join", "officer_term.end"];
  const cases = [
    ["top-level audited write, no helper", "sql", "select app.write_audit_log(c, 'officer', u, 'member.create', 'member', m);", 1],
    ["same, with the helper", "sql", "begin;\nselect app.begin_notification_suppression('repair');\nselect app.write_audit_log(c, 'officer', u, 'member.create', 'member', m);\ncommit;", 0],
    ["a function DEFINITION that writes the audit row is the product, not a repair", "sql",
      "create or replace function app.thing() returns void language plpgsql as $f$\nbegin\n  perform app.write_audit_log(c, 'officer', u, 'member.create', 'member', m);\nend;\n$f$;", 0],
    ["a DO block that calls an audited function", "sql", "do $$\nbegin\n  perform app.create_member(a, b, c);\nend;\n$$;", 1],
    ["only a comment mentions it", "sql", "-- app.write_audit_log(c, 'officer', u, 'member.create', ...) is how this is written\nselect 1;", 0],
    ["an unwatched action", "sql", "select app.write_audit_log(c, 'officer', u, 'member.edit', 'member', m);", 0],
    ["a direct audit_logs insert of a watched action", "sql", "insert into public.audit_logs (community_id, action)\nvalues (c, 'officer_term.end');", 1],
    ["a script string that writes a watched action", "script", "const SQL = `select app.write_audit_log('${C}', 'system', null, 'member.create', 'member', '${M}');`;", 1],
    ["the same script with the helper", "script", "const SQL = `begin; select app.begin_notification_suppression('x'); select app.write_audit_log('${C}', 'system', null, 'member.create', 'member', '${M}'); commit;`;", 0],
    ["a script that ends an officer term", "script", "await sql`select app.end_officer_term(${id}::uuid)`;", 1],
    ["a script comment only", "script", "// calls app.end_officer_term( in production, not here\nconsole.log('hi');", 0],
    ["a revoke naming an audited function is DDL, not a call", "sql", "revoke execute on function app.redeem_invite_link(\n  text, text\n) from public;", 0],
    ["a grant naming an audited function", "sql", "grant execute on function app.create_member(uuid, text) to authenticated;", 0],
    ["a create-or-replace signature line", "sql", "create or replace function app.end_officer_term(\n  p_id uuid\n) returns void language sql as 'select 1';", 0],
    ["a drop function naming an audited function", "sql", "drop function if exists app.create_member(uuid, text);", 0],
    ["a real call right after DDL is still caught", "sql", "grant execute on function app.create_member(uuid, text) to authenticated;\nselect app.create_member(a, b);", 1],
  ];
  const failures = [];
  for (const [name, kind, text, expected] of cases) {
    const got = findUnsuppressedWatchedWrites(text, kind, W).length;
    if (got !== expected) failures.push(`scanner self-test "${name}": expected ${expected} finding(s), got ${got}`);
  }
  if (JSON.stringify(extractTriggerWatched("c_watched constant text[] := array[\n 'a.b', 'c.d'\n];")) !== '["a.b","c.d"]') {
    failures.push("scanner self-test: extractTriggerWatched did not read the trigger's list");
  }
  if (JSON.stringify(extractWorkerWatched('export const WATCHED_ACTIONS = [\n  "a.b",\n  "c.d",\n] as const;')) !== '["a.b","c.d"]') {
    failures.push("scanner self-test: extractWorkerWatched did not read the worker's list");
  }
  return failures;
}
