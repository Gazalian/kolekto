/**
 * payment-fee-alarm.ts — M8.7 alarm 1: the provider's ACTUAL fee against what
 * Kolekto charged, over real contributions.
 *
 * The facts come from app.payment_fee_alarms(since) (20261116100000), which
 * reads only contributions whose provider fee was REPORTED by the provider
 * (provider_fee_basis = 'reported'). Two alarms per contribution:
 *
 *   provider_fee_exceeds_fee_charged  CRITICAL — the provider took more than
 *                                     the total fee Kolekto charged on the
 *                                     payment: Kolekto lost money on it.
 *   provider_fee_exceeds_estimate     WARNING  — the provider took more than
 *                                     the attempt's internal cost estimate
 *                                     (D-28: 1% capped ₦2,000). The sandbox's
 *                                     card fee (1.5%) fires this one.
 *
 * Output is one structured log line per alarm kind with counts and kobo
 * totals — the hook an alerting pipeline (Sentry/log alerts, M8.7) matches
 * on `msg: "payment_fee_alarm"`. No reference, name or email is logged; an
 * operator lists the rows with `select * from app.payment_fee_alarms(<since>)`.
 *
 * Read-only and never fatal. Runs only where the function exists and this
 * role may execute it (the least-privilege worker role is not granted it).
 */

import type postgres from "postgres";

export const FEE_ALARM_INTERVAL_MS = 15 * 60_000;
/** The look-back of each check. Overlaps the interval on purpose: an alarm keeps firing while it is in the window. */
export const FEE_ALARM_WINDOW_MS = 24 * 60 * 60_000;

export const FEE_ALARM_KINDS = ["provider_fee_exceeds_fee_charged", "provider_fee_exceeds_estimate"] as const;
export type FeeAlarmKind = (typeof FEE_ALARM_KINDS)[number];

export const FEE_ALARM_SEVERITY: Readonly<Record<FeeAlarmKind, "critical" | "warning">> = Object.freeze({
  provider_fee_exceeds_fee_charged: "critical",
  provider_fee_exceeds_estimate: "warning",
});

/** One row of app.payment_fee_alarms, bigint columns as digit strings. */
export interface FeeAlarmRow {
  readonly alarm: string;
  readonly channel: string | null;
  readonly overrun_kobo: string;
}

export interface FeeAlarmSummary {
  readonly msg: "payment_fee_alarm";
  readonly alarm: FeeAlarmKind;
  readonly severity: "critical" | "warning";
  readonly window_hours: number;
  readonly contributions: number;
  /** Integer kobo, as a digit string: the sum and the largest single overrun. */
  readonly total_overrun_kobo: string;
  readonly max_overrun_kobo: string;
  readonly channels: readonly string[];
}

function isKind(value: string): value is FeeAlarmKind {
  return (FEE_ALARM_KINDS as readonly string[]).includes(value);
}

/** Pure: rows → one summary per alarm kind that has rows. bigint arithmetic, never a float. */
export function summarizeFeeAlarms(rows: readonly FeeAlarmRow[], windowMs: number = FEE_ALARM_WINDOW_MS): FeeAlarmSummary[] {
  const byKind = new Map<FeeAlarmKind, { count: number; total: bigint; max: bigint; channels: Set<string> }>();
  for (const row of rows) {
    if (!isKind(row.alarm) || !/^\d{1,18}$/.test(row.overrun_kobo)) continue;
    const overrun = BigInt(row.overrun_kobo);
    if (overrun <= 0n) continue;
    const entry = byKind.get(row.alarm) ?? { count: 0, total: 0n, max: 0n, channels: new Set<string>() };
    entry.count += 1;
    entry.total += overrun;
    if (overrun > entry.max) entry.max = overrun;
    entry.channels.add(row.channel ?? "unknown");
    byKind.set(row.alarm, entry);
  }
  return FEE_ALARM_KINDS.flatMap((kind) => {
    const e = byKind.get(kind);
    if (!e) return [];
    return [
      {
        msg: "payment_fee_alarm" as const,
        alarm: kind,
        severity: FEE_ALARM_SEVERITY[kind],
        window_hours: Math.round(windowMs / 3_600_000),
        contributions: e.count,
        total_overrun_kobo: e.total.toString(),
        max_overrun_kobo: e.max.toString(),
        channels: [...e.channels].sort(),
      },
    ];
  });
}

export type FeeAlarmDecision = { enabled: true } | { enabled: false; reason: string };

/** Whether this connection may run the alarm query. */
export async function feeAlarmAllowed(sql: postgres.Sql<Record<string, never>>): Promise<FeeAlarmDecision> {
  const [row] = await sql<{ ok: boolean | null }[]>`
    select coalesce(has_function_privilege(to_regprocedure('app.payment_fee_alarms(timestamptz)'), 'execute'), false) as ok
  `;
  return row?.ok === true ? { enabled: true } : { enabled: false, reason: "payment_fee_alarms_missing_or_not_executable" };
}

/** Read the alarm rows for the window ending now. */
export async function readFeeAlarms(
  sql: postgres.Sql<Record<string, never>> | postgres.TransactionSql<Record<string, never>>,
  nowMs: number,
  windowMs: number = FEE_ALARM_WINDOW_MS,
): Promise<FeeAlarmRow[]> {
  const since = new Date(nowMs - windowMs).toISOString();
  const rows = await sql<FeeAlarmRow[]>`
    select alarm, channel, overrun_kobo::text as overrun_kobo
    from app.payment_fee_alarms(${since}::timestamptz)
  `;
  return [...rows];
}
