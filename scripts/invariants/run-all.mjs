#!/usr/bin/env node
/**
 * The four invariants.
 *
 * These run before features exist, not after. Every one of them corresponds to
 * a way the previous Kolekto went wrong, and each was discoverable by a script
 * that nobody had written:
 *
 *   1. Money is bigint kobo          — a ₦3.59 unexplainable ledger gap
 *   2. RLS on every table            — two tables world-writable for five weeks
 *   3. No money writes outside the DB — money logic spread over 3 runtimes
 *   4. One Paystack caller           — five call sites, no swappable provider
 *
 * Usage: node scripts/invariants/run-all.mjs [--verbose]
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import process from "node:process";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const VERBOSE = process.argv.includes("--verbose");

const SKIP_DIRECTORIES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "coverage",
  "docs", // prose about the old system quotes the very patterns we forbid
  "supabase", // SQL is checked by its own rules below and by pgTAP
]);

/** Walk the tree, yielding files a rule cares about. */
async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else {
      yield join(dir, entry.name);
    }
  }
}

async function collect(extensions, from = ROOT) {
  const files = [];
  try {
    if (!(await stat(from)).isDirectory()) return files;
  } catch {
    return files;
  }
  for await (const file of walk(from)) {
    if (extensions.some((ext) => file.endsWith(ext))) files.push(file);
  }
  return files;
}

const violations = [];
function fail(rule, file, line, text, why) {
  violations.push({ rule, file: relative(ROOT, file).split(sep).join("/"), line, text: text.trim(), why });
}

/** Lines that opt out, for the rare case a rule is genuinely wrong. Must carry a reason. */
const ALLOW = /invariant-allow:\s*\S+/;

async function scanLines(files, onLine) {
  for (const file of files) {
    const content = await readFile(file, "utf8");
    const lines = content.split(/\r?\n/);
    lines.forEach((text, index) => {
      if (ALLOW.test(text)) return;
      onLine({ file, line: index + 1, text, lines, index });
    });
  }
}

// ── 1. Money is bigint kobo (ADR 0003) ──────────────────────────────────────
async function ruleNoFloatMoney() {
  const files = await collect([".ts", ".tsx"], join(ROOT, "packages"));
  files.push(...(await collect([".ts", ".tsx"], join(ROOT, "apps"))));

  // `toFixed` is the specific mechanism that made the old engine's rounding
  // non-deterministic: (1.005).toFixed(2) === "1.00".
  const patterns = [
    [/\.toFixed\s*\(/, "toFixed() is not half-up on binary floats — this is the exact call that produced the old system's rounding errors"],
    [/\bparseFloat\s*\(/, "parseFloat produces a double; money is bigint kobo"],
    [/\bNumber\s*\(\s*[^)]*(amount|price|fee|total|balance|kobo)/i, "wrapping a money value in Number() converts it to a double"],
  ];

  await scanLines(files, ({ file, line, text }) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(text)) return; // commentary explains the rules
    for (const [pattern, why] of patterns) {
      if (pattern.test(text)) fail("money-is-kobo", file, line, text, why);
    }
  });

  // And in SQL: a money column is bigint, never numeric.
  //
  // Comments and string literals are stripped first. Without that, this rule
  // flags its own rationale — every ADR reference to "money" and every
  // permission description containing the word trips it, which trains people to
  // ignore the gate. A rule that cries wolf is worse than no rule.
  const sql = await collect([".sql"], join(ROOT, "supabase", "migrations"));
  for (const file of sql) {
    const content = await readFile(file, "utf8");
    content.split(/\r?\n/).forEach((text, index) => {
      if (ALLOW.test(text)) return;

      const code = text
        .replace(/--.*$/, "") // line comment
        .replace(/'(?:[^']|'')*'/g, "''"); // single-quoted literal

      // A type only counts when it follows an identifier, i.e. a column
      // definition — not when the word appears in prose that survived stripping.
      if (/\b\w+\s+(numeric|decimal|real|double\s+precision|money)\b/i.test(code)) {
        fail(
          "money-is-kobo",
          file,
          index + 1,
          text,
          "money columns are bigint kobo (the app.kobo domain), never numeric or floating point",
        );
      }
    });
  }
}

// ── 2. RLS on every table (SEC-13) ──────────────────────────────────────────
async function ruleRlsCoverage() {
  const sql = await collect([".sql"], join(ROOT, "supabase", "migrations"));

  for (const file of sql) {
    const content = await readFile(file, "utf8");
    const created = [...content.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.(\w+)/gi)].map((m) => m[1]);

    for (const table of created) {
      const enabled = new RegExp(`alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`, "i").test(content);
      const forced = new RegExp(`alter\\s+table\\s+public\\.${table}\\s+force\\s+row\\s+level\\s+security`, "i").test(content);

      if (!enabled || !forced) {
        fail(
          "rls-everywhere",
          file,
          0,
          `public.${table}`,
          `public.${table} is created without ${!enabled ? "ENABLE" : "FORCE"} ROW LEVEL SECURITY. ` +
            `Two tables in the previous production database lacked it and were world-writable for five weeks.`,
        );
      }
    }
  }
}

// ── 3. No money writes outside a database function (SEC-14) ─────────────────
async function ruleNoDirectMoneyWrites() {
  const files = await collect([".ts", ".tsx"], join(ROOT, "apps"));
  files.push(...(await collect([".ts", ".tsx"], join(ROOT, "packages"))));

  const MONEY_TABLES =
    /\.from\(\s*["'`](ledger_entries|ledger_journals|ledger_accounts|contributions|transactions|payment_attempts|installment_plans|withdrawals|balance_releases|refunds|obligations)["'`]\s*\)/;
  const WRITE = /\.(insert|update|upsert|delete)\s*\(/;

  await scanLines(files, ({ file, line, text, lines, index }) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(text)) return;
    if (!MONEY_TABLES.test(text)) return;

    // A write may be chained on the next few lines.
    const window = lines.slice(index, index + 4).join("\n");
    if (WRITE.test(window)) {
      fail(
        "no-direct-money-writes",
        file,
        line,
        text,
        "money tables are written only inside Postgres functions, called through the server (SEC-14, ADR 0008). Application code proposes; the database posts.",
      );
    }
  });
}

// ── 4. One Paystack caller (FIN-02, ADR 0002) ───────────────────────────────
async function ruleSinglePaystackCaller() {
  const files = await collect([".ts", ".tsx"], join(ROOT, "apps"));
  files.push(...(await collect([".ts", ".tsx"], join(ROOT, "packages"))));

  for (const file of files) {
    const normalised = relative(ROOT, file).split(sep).join("/");
    if (normalised.startsWith("packages/adapters/")) continue;

    const content = await readFile(file, "utf8");
    content.split(/\r?\n/).forEach((text, index) => {
      if (ALLOW.test(text)) return;
      if (/^\s*(\/\/|\*|\/\*)/.test(text)) return;
      if (/api\.paystack\.co|PAYSTACK_SECRET_KEY/.test(text)) {
        fail(
          "one-paystack-caller",
          file,
          index + 1,
          text,
          "every Paystack call goes through packages/adapters. The previous system had five call sites across three runtimes, which is why FIN-02's settlement swap was not achievable.",
        );
      }
    });
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────
const rules = [
  ["money is bigint kobo", ruleNoFloatMoney],
  ["RLS on every table", ruleRlsCoverage],
  ["no money writes outside the database", ruleNoDirectMoneyWrites],
  ["one Paystack caller", ruleSinglePaystackCaller],
];

for (const [name, run] of rules) {
  const before = violations.length;
  await run();
  const found = violations.length - before;
  const mark = found === 0 ? "ok" : "FAIL";
  console.log(`${mark.padEnd(4)} ${name}${found ? ` — ${found} violation${found === 1 ? "" : "s"}` : ""}`);
}

if (violations.length > 0) {
  console.error("\nInvariant violations:\n");
  for (const v of violations) {
    console.error(`  ${v.file}${v.line ? `:${v.line}` : ""}`);
    console.error(`    rule: ${v.rule}`);
    if (VERBOSE && v.text) console.error(`    code: ${v.text}`);
    console.error(`    why:  ${v.why}\n`);
  }
  console.error(
    `${violations.length} violation(s). If one is genuinely wrong, append ` +
      `\`invariant-allow: <reason>\` to the line — and expect to justify it in review.\n`,
  );
  process.exit(1);
}

console.log("\nAll four invariants hold.");
