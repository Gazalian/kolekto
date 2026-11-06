// Counts occurrences only. Reads .env.itest in memory to compare exact values; prints key names and counts, never a value.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const [root, envFile] = process.argv.slice(2);
const values = {};
for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const m = /^(KOLEKTO_ITEST_[A-Z_]+)=(.*)$/.exec(line);
  if (m) values[m[1]] = m[2];
}
const password = decodeURIComponent(new URL(values.KOLEKTO_ITEST_DB_URL).password);
const exact = { db_url: values.KOLEKTO_ITEST_DB_URL, password, stack_id: values.KOLEKTO_ITEST_STACK_ID };
const patterns = {
  connection_url: /postgres(?:ql)?:\/\/[^\s"']+/gi,
  scram_verifier: /SCRAM-SHA-256\$/g,
  aws_key: /\bAKIA[0-9A-Z]{16}\b/g,
  jwt: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  phone: /\+234\d{6,}/g,
  prod_ref: new RegExp("busfgcmbnd" + "leljklrcbd", "g"),
  staging_ref: new RegExp("kwolxuoeqw" + "uedydxzncb", "g"),
  run_address: /itest\+[0-9a-f]{8}-\d+@/g,
  failing_row: /Failing row contains/g,
  other_email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/g,
};
const files = [];
const walk = (d) => {
  for (const e of readdirSync(d)) {
    const p = path.join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(root);
const totals = Object.fromEntries([...Object.keys(exact), ...Object.keys(patterns)].map((k) => [k, 0]));
const hits = [];
for (const f of files) {
  const text = readFileSync(f, "utf8");
  for (const [k, v] of Object.entries(exact)) {
    const n = text.split(v).length - 1;
    totals[k] += n;
    if (n) hits.push(`${path.relative(root, f)}: ${k} x${n}`);
  }
  for (const [k, re] of Object.entries(patterns)) {
    const n = (text.match(re) ?? []).length;
    totals[k] += n;
    if (n) hits.push(`${path.relative(root, f)}: ${k} x${n}`);
  }
}
console.log(`files scanned: ${files.length}`);
console.log(JSON.stringify(totals));
for (const h of hits) console.log(h);
