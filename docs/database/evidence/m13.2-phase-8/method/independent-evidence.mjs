// Independent of the tests: reads every delivery of the given run tags from the database (read-only,
// as supabase_admin in the kolekto-itest container) and every Mailpit message (GET only), then matches
// them by recomputed Message-ID. Addresses are never printed.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const tags = process.argv.slice(2);
const DB = "supabase_db_kolekto-itest";
const label = execFileSync("docker", ["inspect", DB, "--format", '{{index .Config.Labels "com.supabase.cli.project"}}'], { encoding: "utf8" }).trim();
if (label !== "kolekto-itest") throw new Error("not the test stack");
const API = "http://127.0.0.1:55424";

const sql = (q) =>
  execFileSync("docker", ["exec", "-i", DB, "psql", "-X", "-qAt", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1"], {
    input: `begin read only;\n${q}\nrollback;`,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
for (const t of tags) if (!/^[0-9a-f]{8}$/.test(t)) throw new Error("run tags are 8 hex characters");
const where = tags.map((t) => `c.slug like 'itest-${t}-%'`).join(" or ");
const rows = JSON.parse(
  sql(`select coalesce(json_agg(x order by created_at), '[]') from (
  select c.slug, d.id::text as id, d.channel::text as channel, d.status::text as status, d.error_code, d.attempt_count, d.recipient_address_assurance as assurance, d.provider_message_id, d.created_at, e.event_type,
    (select count(*) from public.notification_send_attempts a where a.delivery_id = d.id) as grants
  from public.notification_deliveries d join public.communities c on c.id = d.community_id join public.notification_events e on e.id = d.notification_event_id
  where ${where}) x;`).trim(),
);

const messages = [];
for (let start = 0; ; start += 200) {
  const page = await (await fetch(`${API}/api/v1/messages?start=${start}&limit=200`)).json();
  messages.push(...page.messages);
  if (page.messages.length < 200) break;
}
const byId = new Map();
for (const m of messages) {
  const id = m.MessageID.replace(/^<|>$/g, "");
  byId.set(id, [...(byId.get(id) ?? []), m]);
}
const info = await (await fetch(`${API}/api/v1/info`)).json();
console.log(`mailpit: Messages ${info.Messages}, SMTPAccepted ${info.RuntimeStats.SMTPAccepted}, SMTPRejected ${info.RuntimeStats.SMTPRejected}, MessagesDeleted ${info.RuntimeStats.MessagesDeleted}`);
console.log("run_tag | event | channel | status | error_code | attempts | grants | assurance | delivery_id | stored_message_id_matches_recomputed | mailpit_copies");
const totals = {};
for (const r of rows) {
  const expected = `${createHash("sha256").update(r.id).digest("hex").slice(0, 32)}@kolekto.invalid`;
  const copies = byId.get(expected)?.length ?? 0;
  const tag = /^itest-([0-9a-f]{8})-/.exec(r.slug)[1];
  const stored = r.provider_message_id === null ? "none" : String(r.provider_message_id === expected);
  console.log([tag, r.event_type, r.channel, r.status, r.error_code ?? "-", r.attempt_count, r.grants, r.assurance ?? "-", r.id, stored, copies].join(" | "));
  const t = (totals[tag] ??= { deliveries: 0, email: 0, grants: 0, copies: 0, duplicated: 0 });
  t.deliveries += 1;
  if (r.channel === "email") t.email += 1;
  t.grants += Number(r.grants);
  t.copies += copies;
  if (copies > 1) t.duplicated += 1;
}
console.log(`totals: ${JSON.stringify(totals)}`);
const outside = messages.filter((m) => m.To.some((t) => !/\.example\.test$/.test(t.Address)) || m.From.Address !== "noreply@kolekto.test").length;
console.log(`mailpit messages with a recipient outside .example.test or a sender other than the test sender: ${outside}`);
console.log(`mailpit message ids carrying more than one copy: ${[...byId.values()].filter((v) => v.length > 1).length}`);
