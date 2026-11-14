/**
 * paystack-sandbox.ts — M8.9 sandbox matrix runner (manual, Paystack TEST mode only).
 *
 * Drives the real orchestrator (@kolekto/payments) with the real Paystack
 * adapter against the LOCAL dev database, inside ONE transaction that is
 * rolled back at the end — nothing is left behind. Each orchestrator call
 * runs in its own savepoint, as in the worker integration test.
 *
 * Why not through the web app: `local` always selects the fake provider and
 * `staging` refuses a non-https APP_BASE_URL, so the app path needs a public
 * HTTPS host. This runner covers everything that does not need Paystack to
 * reach us (initialize, hosted checkout, verify, T1, T2, fees field). Webhook
 * delivery rows of the §9 matrix need a public URL and are not covered here.
 *
 * Usage (from apps/worker):
 *   node --experimental-strip-types test/sandbox/paystack-sandbox.ts <workdir> [scenario-id ...]
 *
 * With scenario ids, only those scenarios are initialized (e.g.
 * `s1-card-success s3-card-declined` for the card rows); without, all six.
 *
 * The runner writes <workdir>/checkouts.json (scenario → reference + hosted
 * checkout URL), then waits. A human pays (or does not pay) on Paystack's
 * hosted page with Paystack's published TEST cards, then creates
 * <workdir>/confirm-<scenario> to make the runner call confirmPayment for
 * that scenario (twice: the second proves idempotency). <workdir>/finish
 * writes results.json and rolls back. A verify is never sent before the
 * matching confirm file exists: Paystack reports an unpaid initialized
 * transaction as `abandoned`, which T1 records as failed.
 *
 * Safety: refuses anything but an `sk_test_` key. Reads only the two
 * PAYSTACK_* values from the repo-root .env.local and never prints them.
 * Refuses any database other than 127.0.0.1:54322 (local dev stack).
 */

import { randomUUID, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import postgres from "postgres";

import { createPaystackPaymentProvider, tryLoadPaystackConfigFromEnv } from "@kolekto/adapters";
import type { PaymentDb } from "@kolekto/db";
import { confirmPayment, type PaymentContext, startCheckout } from "@kolekto/payments";

import { type FlowFixture, type FlowIds, type FlowName, type PaymentCommunity, seedFlow, seedPaymentCommunity } from "../support/itest-payment-flows.ts";

const LOCAL_DEV_DB = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
/** Never resolves anywhere (RFC 2606). Paystack redirects the browser here after paying; nothing listens. */
const APP_ORIGIN = "https://sandbox.kolekto.invalid";
const DEADLINE_MS = 75 * 60 * 1000;

type Tx = postgres.TransactionSql<Record<string, never>>;

interface Scenario {
  id: string;
  flow: FlowName;
  /** Pay as member B (no obligation) on the fixed collection: obligation-on-capture. */
  asMemberB?: boolean;
  note: string;
}

const SCENARIOS: Scenario[] = [
  { id: "s1-card-success", flow: "fixed", note: "dues, member A with obligation, host absorbs; success card" },
  { id: "s2-transfer", flow: "tiered", note: "tier, contributor pays fees; bank transfer channel" },
  { id: "s3-card-declined", flow: "open", note: "open amount; declined test card" },
  { id: "s4-abandoned", flow: "fundraiser", note: "fundraiser; checkout opened, never paid" },
  { id: "s5-obligation-on-capture", flow: "fixed", asMemberB: true, note: "dues, member B with no obligation; success card" },
  { id: "s6-early-callback-then-pay", flow: "items", note: "items; verify before paying (abandoned), then pay, then verify again" },
];

/**
 * The repo-root .env.local as a plain record, handed to the adapter's own
 * env loader. Only that loader names the Paystack variables (invariant 4).
 * Nothing here is written to process.env or printed.
 */
function loadDotEnv(repoRoot: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const line of readFileSync(join(repoRoot, ".env.local"), "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

function ids(): FlowIds {
  return {
    uuid: () => randomUUID(),
    slug: () => `sbx-${randomBytes(5).toString("hex")}`,
    address: () => `sandbox-${randomBytes(5).toString("hex")}@example.com`,
  };
}

function savepointDb(tx: Tx): PaymentDb {
  return (fn) => tx.savepoint((sp) => fn(sp)) as ReturnType<typeof fn>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function evidence(tx: Tx, attemptId: string): Promise<unknown> {
  const [attempt] = await tx`
    select status::text as status, amount_kobo::text, contribution_kobo::text, total_fees_kobo::text, net_kobo::text,
           fee_bearer::text, obligation_id::text, member_id::text, review_reason
    from public.payment_attempts where id = ${attemptId}`;
  const statements = await tx`
    select status_raw, status_mapped, amount_kobo::text, currency, provider_fee_kobo::text, channel,
           (authorization_hash is not null) as has_auth_hash, observed_at
    from public.provider_transactions where attempt_id = ${attemptId} order by observed_at`;
  const contributions = await tx`
    select c.status::text as status, c.contribution_kobo::text, c.net_kobo::text, c.total_charged_kobo::text,
           c.total_fees_kobo::text, c.provider_fee_kobo::text, c.provider_fee_basis, c.fee_bearer::text,
           c.obligation_id::text, o.status::text as obligation_status, o.expected_amount_kobo::text as obligation_expected_kobo,
           (o.assigned_by is null) as obligation_system_assigned
    from public.contributions c left join public.obligations o on o.id = c.obligation_id
    where c.attempt_id = ${attemptId}`;
  return { attempt, statements, contributions };
}

async function main(): Promise<void> {
  const workdir = resolve(process.argv[2] ?? "");
  if (!process.argv[2] || !existsSync(workdir)) throw new Error("usage: paystack-sandbox.ts <existing workdir>");
  const repoRoot = resolve(import.meta.dirname, "../../../..");
  const only = process.argv.slice(3);
  const unknown = only.filter((id) => !SCENARIOS.some((s) => s.id === id));
  if (unknown.length > 0) throw new Error(`unknown scenario(s): ${unknown.join(", ")}`);
  const scenarios = only.length === 0 ? SCENARIOS : SCENARIOS.filter((s) => only.includes(s.id));

  const config = tryLoadPaystackConfigFromEnv(loadDotEnv(repoRoot));
  if (config === null) throw new Error("Paystack secret key / webhook secret missing from .env.local");
  if (!config.secretKey.startsWith("sk_test_")) throw new Error("REFUSING: not a Paystack TEST secret key");
  const provider = createPaystackPaymentProvider(config);

  const sql = postgres(LOCAL_DEV_DB, { max: 1, prepare: false, transform: { undefined: null } });
  const results: Record<string, unknown> = {};
  const log = (msg: string) => console.log(`[sandbox] ${new Date().toISOString()} ${msg}`);

  try {
    await sql.begin(async (tx) => {
      const t = tx as unknown as Tx;
      const scope = ids();
      const community: PaymentCommunity = await seedPaymentCommunity(t, scope);
      const ctx: PaymentContext = { db: savepointDb(t), provider };

      const fixtures = new Map<FlowName, FlowFixture>();
      const checkouts: Record<string, { reference: string; checkoutUrl: string; attemptId: string; note: string; fees: unknown }> = {};

      for (const s of scenarios) {
        let flow = fixtures.get(s.flow);
        if (!flow) {
          flow = await seedFlow(t, scope, community, s.flow);
          fixtures.set(s.flow, flow);
        }
        const memberId = s.asMemberB ? community.memberIds[1] : flow.memberId;
        const started = await startCheckout(ctx, {
          environment: "staging",
          appOrigin: APP_ORIGIN,
          collectionId: flow.collectionId,
          collectionCategory: flow.category,
          collectionSlug: flow.collectionSlug,
          communitySlug: community.communitySlug,
          amountModel: flow.amountModel,
          feeBearer: flow.feeBearer,
          resolved: flow.resolved,
          memberId,
          contributorName: "Sandbox Contributor",
          contributorEmail: scope.address(),
          contributorPhone: "+2348097771999",
          answers: {},
          attendeeNames: flow.attendeeNames,
          checkoutIdempotencyKey: randomUUID(),
        });
        if (started.outcome !== "ok") throw new Error(`${s.id}: checkout did not start: ${JSON.stringify(started)}`);
        checkouts[s.id] = {
          reference: started.reference,
          checkoutUrl: started.checkoutUrl,
          attemptId: started.attemptId,
          note: s.note,
          fees: JSON.parse(JSON.stringify(started.fees, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
        };
        log(`${s.id}: initialized ${started.reference}`);
      }
      writeFileSync(join(workdir, "checkouts.json"), JSON.stringify(checkouts, null, 2));
      log("checkouts.json written; waiting for confirm-<scenario> / finish files");

      const confirmedCount: Record<string, number> = {};
      const deadline = Date.now() + DEADLINE_MS;
      while (Date.now() < deadline && !existsSync(join(workdir, "finish"))) {
        for (const s of scenarios) {
          // confirm-<id> may be created more than once (s6): each new mtime-free marker is a numbered file.
          const n = (confirmedCount[s.id] ?? 0) + 1;
          const marker = join(workdir, n === 1 ? `confirm-${s.id}` : `confirm-${s.id}-${n}`);
          if (!existsSync(marker)) continue;
          confirmedCount[s.id] = n;
          const ref = checkouts[s.id]!.reference;
          const first = await confirmPayment(ctx, ref);
          const second = await confirmPayment(ctx, ref);
          const ev = await evidence(t, checkouts[s.id]!.attemptId);
          results[`${s.id}#${n}`] = { first, second, evidence: ev };
          writeFileSync(join(workdir, "results.json"), JSON.stringify(results, null, 2));
          log(`${s.id}#${n}: first=${first.outcome} second=${second.outcome}`);
        }
        await sleep(2000);
      }
      log("finishing; rolling back");
      throw new RollbackSignal();
    });
  } catch (error) {
    if (!(error instanceof RollbackSignal)) throw error;
  } finally {
    await sql.end({ timeout: 5 });
  }
  writeFileSync(join(workdir, "results.json"), JSON.stringify(results, null, 2));
  log("rolled back; done");
}

class RollbackSignal extends Error {}

await main();
