#!/usr/bin/env node
/**
 * The six invariants.
 *
 * These run before features exist, not after. Every one of them corresponds to
 * a way the previous Kolekto went wrong, and each was discoverable by a script
 * that nobody had written:
 *
 *   1. Money is bigint kobo          — a ₦3.59 unexplainable ledger gap
 *   2. RLS on every table            — two tables world-writable for five weeks
 *   3. No money writes outside the DB — money logic spread over 3 runtimes
 *   4. One Paystack caller           — five call sites, no swappable provider
 *   5. One fee implementation        — two versions of "net", and the difference
 *                                      between them WAS the largest drift bucket
 *   6. App functions state who may   — PUBLIC EXECUTE is the default, and anon
 *      execute them                    inherits PUBLIC
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

  // M8.1 adds the tables it created: the ledger's own three were already named
  // here before they existed, which is the point of writing an invariant early.
  const MONEY_TABLES =
    /\.from\(\s*["'`](ledger_entries|ledger_journals|ledger_accounts|ledger_account_codes|contributions|transactions|payment_attempts|installment_plans|withdrawals|balance_releases|refunds|obligations|fee_schedules|fee_schedule_category_rates|withdrawal_fee_schedules|withdrawal_fee_brackets|financial_events|financial_operation_claims)["'`]\s*\)/;
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

// ── 5. One fee implementation (D-12, ADR 0015) ──────────────────────────────
//
// The largest single drift bucket in the previous system was TWO
// implementations of "net". The live Edge writer summed raw amounts; the Node
// writers deducted fees for the organiser-borne case. The drift between the two
// balances was, exactly, the fees.
//
// So `calculateFees()` in packages/domain/src/fees.ts is the only fee
// arithmetic in Kolekto. This rule enforces two halves of that:
//
//   a. no fee arithmetic anywhere else — a rate multiplied into an amount
//   b. no new `calculateFees` call site without a deliberate decision
//
// The database holds no fee arithmetic either; that half is asserted by
// supabase/tests/19_fee_schedules.sql, because a SQL function would be
// invisible to a scan of TypeScript.
async function ruleOneFeeImplementation() {
  // The fee engine and the money primitives ARE the implementation.
  const ENGINE = new Set(["packages/domain/src/fees.ts", "packages/domain/src/money.ts"]);

  // Where `calculateFees` may legitimately be called. A preview screen is a
  // legitimate caller — an organiser deciding who bears the fees is entitled to
  // see the arithmetic. Tests may call it freely; they are not product code.
  //
  // When the payment-attempt writer arrives it is added here, deliberately, in
  // the same commit that adds it — which is the point of an allowlist.
  const CALLERS = new Set([
    "packages/domain/src/fees.ts",
    "apps/web/app/c/[slug]/collections/FeeConfigurator.tsx",
  ]);

  const files = await collect([".ts", ".tsx"], join(ROOT, "packages"));
  files.push(...(await collect([".ts", ".tsx"], join(ROOT, "apps"))));

  // A money-ish identifier multiplied by a FRACTIONAL literal. That is what a
  // hand-rolled fee looks like: `amount * 0.015`, `total * 1.015`.
  //
  // Deliberately not "money divided by any literal": `total / 100n` is a
  // kobo-to-naira conversion, which is a display concern and not a fee. A rule
  // that flags those trains people to ignore it, and a gate nobody reads is
  // worse than no gate.
  const FRACTIONAL_RATE =
    /\b(amount|amounts|price|prices|fee|fees|total|totals|net|payable|gross|subtotal|kobo|balance)\w*\s*\*\s*\(?\s*\d*\.\d+/i;

  // Dividing by a basis-point divisor. There is exactly one legitimate place to
  // convert basis points into an amount, and it is `applyRate()` in money.ts.
  const BPS_DIVISION = /[*/]\s*10_?000\b/;

  // And a rate named directly, outside the engine that owns them.
  const RATE_ARITHMETIC =
    /\b(platformRate|gatewayRate|vatRate)\b\s*[*/]|[*/]\s*\b(platformRate|gatewayRate|vatRate)\b/;

  await scanLines(files, ({ file, line, text }) => {
    const normalised = relative(ROOT, file).split(sep).join("/");
    if (ENGINE.has(normalised)) return;
    if (/^\s*(\/\/|\*|\/\*)/.test(text)) return; // commentary explains the rules

    if (FRACTIONAL_RATE.test(text) || BPS_DIVISION.test(text) || RATE_ARITHMETIC.test(text)) {
      fail(
        "one-fee-implementation",
        file,
        line,
        text,
        "fee arithmetic lives only in packages/domain/src/fees.ts (D-12). The previous system had two implementations of 'net' and the difference between them was the largest drift bucket in production.",
      );
    }
  });

  // b. The call-site allowlist.
  for (const file of files) {
    const normalised = relative(ROOT, file).split(sep).join("/");
    if (CALLERS.has(normalised)) continue;
    if (/\.test\.tsx?$/.test(normalised)) continue;

    const content = await readFile(file, "utf8");
    content.split(/\r?\n/).forEach((text, index) => {
      if (ALLOW.test(text)) return;
      if (/^\s*(\/\/|\*|\/\*)/.test(text)) return;
      if (/\bcalculateFees\s*\(/.test(text)) {
        fail(
          "one-fee-implementation",
          file,
          index + 1,
          text,
          `calculateFees() is called from an unlisted module. Every caller must store the breakdown it produced (D-16) rather than recomputing it later — add this file to CALLERS in scripts/invariants/run-all.mjs, deliberately, in the commit that needs it.`,
        );
      }
    });
  }
}

// ── 6. Every app function states who may execute it (SEC-12, M8.2) ──────────
//
// Postgres grants EXECUTE to PUBLIC on every new function. `20260917121100`
// counters that with
//
//     alter default privileges in schema app revoke execute on functions from public;
//
// which is the right mechanism — but `alter default privileges` is recorded per
// GRANTOR ROLE, so it covers objects created by the role that ran it and not
// necessarily others. The repository already knew this; `20260919120100`'s own
// comment says so. Empirically the six trigger functions added in M8.1 arrived
// PUBLIC-executable anyway, and only `02_grant_matrix.sql` asserting the
// anon-executable set exactly caught them — anon inherits PUBLIC, so a PUBLIC
// grant is an anon grant.
//
// Three SECURITY DEFINER functions driving the payment state machine, executable
// by anybody holding the publishable key that ships in every page's JavaScript,
// is how the previous system exposed its payment ledger. Phase 4 adds many
// `app.*` functions and the next ones post journals.
//
// So the rule is not "revoke from PUBLIC" — the migration already does that
// broadly. The rule is that **reachability is stated**: every `app.*` function
// must carry an explicit `revoke execute` or an explicit `grant execute`
// somewhere in the migration set, so who can call it is a decision on the record
// rather than a default nobody looked at.
async function ruleAppFunctionsStateTheirReachability() {
  const sql = await collect([".sql"], join(ROOT, "supabase", "migrations"));

  // Pre-M8.2 internal helpers and trigger functions. Every one is currently
  // unreachable by `anon` and `authenticated` (verified against the live
  // database), covered by the schema-wide revokes rather than by a named one.
  //
  // THIS LIST IS FROZEN. It may shrink — adding an explicit revoke for one of
  // these is a small, welcome change — and it must never grow. A new function
  // that needs to be here is a new function whose reachability nobody stated.
  const GRANDFATHERED = new Set([
    "all_amounts_positive", "assert_attribute_definition_limit", "assert_audience_group_tenancy",
    "assert_community_has_owner", "assert_item_is_consistent",
    "assert_member_attribute_value_consistent", "assert_obligation_tenancy", "assert_tier_is_consistent",
    "block_audit_mutation", "block_manual_paid_status", "current_user_id",
    "derive_collection_audience_mode", "enforce_collection_delete_guard", "enforce_member_delete_guard",
    "enforce_obligation_delete_guard", "enforce_reference_immutability", "generate_secret_token",
    "generate_unique_collection_slug", "generate_unique_community_slug",
    "next_member_code", "normalise_phone", "propagate_definition_uniqueness", "require_permission",
    "resolve_collection_audience", "set_member_attributes", "set_updated_at", "slugify",
    "uuid_generate_v7", "write_audit_log",
  ]);

  const created = new Map(); // name → {file, line}
  const decided = new Set(); // name → has an explicit revoke or grant

  for (const file of sql) {
    const content = await readFile(file, "utf8");
    const lines = content.split(/\r?\n/);

    lines.forEach((text, index) => {
      if (ALLOW.test(text)) return;

      const createdHere = /create\s+(?:or\s+replace\s+)?function\s+app\.([a-z0-9_]+)/i.exec(text);
      if (createdHere?.[1] && !created.has(createdHere[1].toLowerCase())) {
        created.set(createdHere[1].toLowerCase(), { file, line: index + 1 });
      }

      const decidedHere = /(?:revoke|grant)\s+execute\s+on\s+function\s+app\.([a-z0-9_]+)/i.exec(text);
      if (decidedHere?.[1]) decided.add(decidedHere[1].toLowerCase());
    });
  }

  for (const [name, where] of created) {
    if (decided.has(name) || GRANDFATHERED.has(name)) continue;
    fail(
      "app-function-reachability",
      where.file,
      where.line,
      `app.${name}`,
      `app.${name} is created without stating who may execute it. Add an explicit ` +
        `\`revoke execute on function app.${name}(...) from public, anon, authenticated;\` for an internal ` +
        `or trigger function, or an explicit \`grant execute ... to authenticated;\` for a callable one. ` +
        `Postgres grants EXECUTE to PUBLIC by default and anon inherits PUBLIC, which is how the previous ` +
        `system's payment state machine became callable with the publishable key.`,
    );
  }

  // The grandfather list may only shrink. A name in it that has since gained an
  // explicit decision should be removed, and saying so keeps the list honest
  // rather than letting it rot.
  if (VERBOSE) {
    const redundant = [...GRANDFATHERED].filter((n) => decided.has(n));
    if (redundant.length > 0) {
      console.log(
        `note  ${redundant.length} grandfathered function(s) now have an explicit decision and can be ` +
          `removed from GRANDFATHERED: ${redundant.join(", ")}`,
      );
    }
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────
const rules = [
  ["money is bigint kobo", ruleNoFloatMoney],
  ["RLS on every table", ruleRlsCoverage],
  ["no money writes outside the database", ruleNoDirectMoneyWrites],
  ["one Paystack caller", ruleSinglePaystackCaller],
  ["one fee implementation", ruleOneFeeImplementation],
  ["every app function states who may execute it", ruleAppFunctionsStateTheirReachability],
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

console.log("\nAll six invariants hold.");
