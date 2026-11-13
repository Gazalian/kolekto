/**
 * payments.ts — fixtures and checks for the M8.5 payment journeys in the
 * browser suite (payments.spec.ts), plus the review-screen check every spec
 * that reaches "Continue" on a public collection page uses.
 *
 * Seeding reuses the seven-flow fixtures of the worker's integration lane
 * (apps/worker/test/support/itest-payment-flows.ts), so the browser and the
 * integration test pay for exactly the same collections. Here they run in a
 * transaction that COMMITS: the web server has to see the rows. Like
 * notifications.ts, it uses a direct superuser connection to the LOCAL stack,
 * and it refuses any database that is not on this machine. Every seed has its
 * own community, so runs never collide and need no teardown.
 *
 * Collections are inserted, not created through the wizard: creation has its
 * own specs (collection-types.spec.ts), and these tests are about paying.
 */

import { randomBytes, randomUUID } from "node:crypto";

import { expect, type Page } from "@playwright/test";
import postgres from "postgres";

import {
  type FlowFixture,
  type FlowIds,
  type FlowName,
  type PaymentCommunity,
  seedFlow,
  seedPaymentCommunity,
} from "../../../apps/worker/test/support/itest-payment-flows.ts";

export { FLOW_NAMES, type FlowName } from "../../../apps/worker/test/support/itest-payment-flows.ts";

type Sql = postgres.Sql<Record<string, never>>;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The local stack's database. These helpers COMMIT rows, so anything not on this machine is refused. */
function databaseUrl(): string {
  const url =
    process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  const host = new URL(url).hostname;
  if (!LOOPBACK.has(host)) {
    throw new Error(`payments E2E helpers write committed rows and only run against a local database (got host ${host})`);
  }
  return url;
}

async function withSql<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = postgres(databaseUrl(), { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const token = (): string => randomBytes(5).toString("hex");

const ids: FlowIds = {
  uuid: () => randomUUID(),
  slug: () => `e2e-pay-${token()}`,
  address: () => `e2e-pay-${token()}@example.test`,
};

export interface SeededFlow {
  community: PaymentCommunity;
  flow: FlowFixture;
  /** The public collection page. */
  path: string;
}

/** A fresh community with one active collection of the given flow, committed. */
export async function seedPaymentFlow(name: FlowName): Promise<SeededFlow> {
  return withSql((sql) =>
    sql.begin(async (tx) => {
      const community = await seedPaymentCommunity(tx, ids);
      const flow = await seedFlow(tx, ids, community, name);
      return { community, flow, path: `/${community.communitySlug}/${flow.collectionSlug}` };
    }),
  );
}

// ── Reading the end state (read-only) ────────────────────────────────────────

export interface AttemptState {
  id: string;
  status: string;
  amountKobo: bigint;
  contributionKobo: bigint;
  totalFeesKobo: bigint;
  feeBearer: string;
  obligationId: string | null;
  /** Units per reservation status, e.g. { reserved: 2 }. Empty when nothing is limited. */
  stock: Record<string, number>;
  contributions: { id: string; contributionKobo: bigint; totalChargedKobo: bigint; memberId: string | null }[];
  contributionLines: number;
  attendeeNames: string[];
  obligationStatus: string | null;
}

export async function attemptState(reference: string): Promise<AttemptState> {
  return withSql(async (sql) => {
    const [a] = await sql<
      { id: string; status: string; amount_kobo: string; contribution_kobo: string; total_fees_kobo: string; fee_bearer: string; obligation_id: string | null; attendee_names: string[] }[]
    >`
      select a.id::text as id, a.status::text as status, a.amount_kobo::text as amount_kobo,
             a.contribution_kobo::text as contribution_kobo, a.total_fees_kobo::text as total_fees_kobo,
             a.fee_bearer::text as fee_bearer, a.obligation_id::text as obligation_id, i.attendee_names
      from public.payment_attempts a
      join public.contribution_intents i on i.id = a.intent_id
      where a.reference = ${reference}`;
    if (!a) throw new Error(`no payment attempt for ${reference}`);
    const stock = await sql<{ status: string; units: number }[]>`
      select status::text as status, sum(quantity)::int as units from public.stock_reservations
      where attempt_id = ${a.id} group by status`;
    const contributions = await sql<{ id: string; contribution_kobo: string; total_charged_kobo: string; member_id: string | null }[]>`
      select id::text as id, contribution_kobo::text as contribution_kobo, total_charged_kobo::text as total_charged_kobo,
             member_id::text as member_id
      from public.contributions where attempt_id = ${a.id}`;
    const [lines] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.contribution_lines l
      join public.contributions c on c.id = l.contribution_id where c.attempt_id = ${a.id}`;
    const [obligation] = a.obligation_id
      ? await sql<{ status: string }[]>`select status::text as status from public.obligations where id = ${a.obligation_id}`
      : [];
    return {
      id: a.id,
      status: a.status,
      amountKobo: BigInt(a.amount_kobo),
      contributionKobo: BigInt(a.contribution_kobo),
      totalFeesKobo: BigInt(a.total_fees_kobo),
      feeBearer: a.fee_bearer,
      obligationId: a.obligation_id,
      stock: Object.fromEntries(stock.map((r) => [r.status, r.units])),
      contributions: contributions.map((c) => ({
        id: c.id,
        contributionKobo: BigInt(c.contribution_kobo),
        totalChargedKobo: BigInt(c.total_charged_kobo),
        memberId: c.member_id,
      })),
      contributionLines: lines?.n ?? 0,
      attendeeNames: a.attendee_names ?? [],
      obligationStatus: obligation?.status ?? null,
    };
  });
}

// ── The review screen ────────────────────────────────────────────────────────

/** "₦1,234.50" → 123450n. For checking what the page shows; the server never parses display text. */
export function nairaTextToKobo(text: string): bigint {
  const match = /^₦([\d,]+)(?:\.(\d{2}))?$/.exec(text.trim());
  if (!match) throw new Error(`not a naira amount: ${JSON.stringify(text)}`);
  return BigInt(match[1]!.replaceAll(",", "")) * 100n + BigInt(match[2] ?? "0");
}

export interface ReviewFigures {
  contribution: string;
  /** Only when the contributor pays the fees; null when the community covers them. */
  processingFee: string | null;
  kolektoFee: string | null;
  total: string;
}

/**
 * The M8.5 review screen after Continue: the server-frozen figures, and
 * nothing charged yet. Checks the heading, that the Contribution row is the
 * amount the order resolved to, that the fees add up to the total (or that the
 * community covers them and the total is the contribution), and that the only
 * way on is the contributor's own "Pay ₦…" — no receipt, no success message.
 */
export async function expectPaymentReview(
  page: Page,
  expected: { contributorName: string; contribution: string },
): Promise<ReviewFigures> {
  await expect(page.getByRole("heading", { name: `Review and pay, ${expected.contributorName}` })).toBeVisible();

  const figure = (label: string) =>
    page.locator("dl > div").filter({ has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }) }).locator("dd");

  await expect(figure("Contribution")).toHaveText(expected.contribution);
  const total = ((await figure("Total to pay").textContent()) ?? "").trim();

  let processingFee: string | null = null;
  let kolektoFee: string | null = null;
  if ((await figure("Processing fee").count()) > 0) {
    processingFee = ((await figure("Processing fee").textContent()) ?? "").trim();
    kolektoFee = ((await figure("Kolekto fee").textContent()) ?? "").trim();
    expect(nairaTextToKobo(processingFee), "a contributor-paid fee is never zero").toBeGreaterThan(0n);
    expect(
      nairaTextToKobo(expected.contribution) + nairaTextToKobo(processingFee) + nairaTextToKobo(kolektoFee),
      "contribution + processing fee + Kolekto fee = total to pay",
    ).toBe(nairaTextToKobo(total));
  } else {
    expect(total, "when the community covers the fees, the contributor pays the contribution").toBe(expected.contribution);
    await expect(page.getByText(/covers the payment fees\.$/)).toBeVisible();
  }

  // Nothing has been charged: the next step is the contributor's own Pay.
  await expect(page.getByRole("button", { name: `Pay ${total}`, exact: true })).toBeEnabled();
  await expect(page.getByText("Payment Successful")).toHaveCount(0);

  return { contribution: expected.contribution, processingFee, kolektoFee, total };
}
