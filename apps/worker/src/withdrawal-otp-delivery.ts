/**
 * withdrawal-otp-delivery.ts — emails the requesting member's one-time code
 * for a withdrawal (owner decision 2026-11-19, Option A).
 *
 * For each challenge the database hands out (app.claim_withdrawal_otp_deliveries):
 *   1. generate a 6-digit code with crypto.randomInt (domain helper);
 *   2. store HMAC(secret, challenge:code) — BEFORE sending, so a delivered
 *      code is always verifiable (app.record_withdrawal_otp_issued; false →
 *      the challenge was superseded or cancelled meanwhile: do not send);
 *   3. send the email; record sent / delivery_failed.
 *
 * The code exists only in this function's memory and in the email. It is
 * never logged, never stored, never returned. Honours the email pause switch
 * (app.email_sending_enabled): while paused nothing is claimed; an unsent
 * challenge lapses after 10 minutes and the member asks for a new code.
 *
 * Logs carry counts only.
 */

import type { EmailMessage, EmailProvider } from "@kolekto/adapters";
import { claimWithdrawalOtpDeliveries, type PaymentDb, recordWithdrawalOtpDelivery, recordWithdrawalOtpIssued, type WithdrawalOtpDelivery } from "@kolekto/db";
import { formatNaira, generateWithdrawalOtp, hashWithdrawalOtp, kobo, WITHDRAWAL_OTP_VALIDITY_MINUTES } from "@kolekto/domain";
import type postgres from "postgres";

export const WITHDRAWAL_OTP_BATCH = 10;

export const WITHDRAWAL_OTP_FUNCTIONS: readonly string[] = Object.freeze([
  "app.claim_withdrawal_otp_deliveries(integer)",
  "app.record_withdrawal_otp_issued(uuid, text)",
  "app.record_withdrawal_otp_delivery(uuid, boolean, text)",
]);

export type WithdrawalOtpDecision = { enabled: true } | { enabled: false; reason: string };

/** Pure: whether the stage may run. */
export function decideWithdrawalOtpDelivery(input: { functionsOk: boolean; hasEmail: boolean; secret: string | null }): WithdrawalOtpDecision {
  if (!input.functionsOk) return { enabled: false, reason: "otp_functions_missing_or_not_executable" };
  if (!input.hasEmail) return { enabled: false, reason: "email_provider_not_configured" };
  if (input.secret === null) return { enabled: false, reason: "otp_secret_missing" };
  return { enabled: true };
}

export async function withdrawalOtpFunctionsOk(sql: postgres.Sql<Record<string, never>>): Promise<boolean> {
  const [row] = await sql<{ ok: boolean | null }[]>`
    select bool_and(to_regprocedure(f) is not null and has_function_privilege(current_user, to_regprocedure(f), 'EXECUTE')) as ok
    from unnest(${WITHDRAWAL_OTP_FUNCTIONS as string[]}::text[]) as f
  `;
  return row?.ok === true;
}

/** The email. States plainly that the code confirms the request and is not approval or payment. */
export function withdrawalOtpEmail(d: WithdrawalOtpDelivery, code: string): EmailMessage {
  const amount = formatNaira(kobo(d.amountKobo));
  const greeting = d.recipientName ? `Hello ${d.recipientName},` : "Hello,";
  const lines = [
    greeting,
    "",
    `Your Kolekto withdrawal confirmation code is: ${code}`,
    "",
    `It confirms that you asked to withdraw ${amount} from "${d.collectionName}" (${d.communityName}) to your ${d.bankName} account ending ${d.accountLast4} (reference ${d.withdrawalReference}).`,
    "",
    `The code is valid for ${WITHDRAWAL_OTP_VALIDITY_MINUTES} minutes and can be used once.`,
    "",
    "Entering this code does not approve or pay the withdrawal. Once you have verified it, an authorised community administrator (never you) must still review and approve it, and the money is sent only after that.",
    "",
    "If you did not ask for this withdrawal, do not share the code. Cancel the request in Kolekto and tell your community's administrators. Kolekto will never ask you for this code by phone, chat or email.",
  ];
  const text = lines.join("\n");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const html = [
    `<p>${esc(greeting)}</p>`,
    `<p>Your Kolekto withdrawal confirmation code is:</p>`,
    `<p style="font-size:28px;font-weight:700;letter-spacing:6px;font-family:monospace">${esc(code)}</p>`,
    `<p>It confirms that you asked to withdraw <strong>${esc(amount)}</strong> from “${esc(d.collectionName)}” (${esc(d.communityName)}) to your ${esc(d.bankName)} account ending ${esc(d.accountLast4)} (reference ${esc(d.withdrawalReference)}).</p>`,
    `<p>The code is valid for ${WITHDRAWAL_OTP_VALIDITY_MINUTES} minutes and can be used once.</p>`,
    `<p><strong>Entering this code does not approve or pay the withdrawal.</strong> Once you have verified it, an authorised community administrator (never you) must still review and approve it, and the money is sent only after that.</p>`,
    `<p>If you did not ask for this withdrawal, do not share the code. Cancel the request in Kolekto and tell your community's administrators. Kolekto will never ask you for this code by phone, chat or email.</p>`,
  ].join("\n");
  return { to: d.email ?? "", subject: `Your Kolekto withdrawal verification code (${d.withdrawalReference})`, text, html };
}

export interface WithdrawalOtpDeliveryContext {
  db: PaymentDb;
  email: EmailProvider;
  secret: string;
  sendingEnabled: () => Promise<boolean>;
  /** Tests inject a deterministic code; production uses crypto.randomInt. */
  generate?: () => string;
}

export type WithdrawalOtpOutcome = "sent" | "delivery_failed" | "email_not_verified" | "superseded" | "error";

export interface WithdrawalOtpReport {
  readonly paused: boolean;
  readonly outcomes: readonly WithdrawalOtpOutcome[];
}

export async function deliverWithdrawalOtps(ctx: WithdrawalOtpDeliveryContext, limit = WITHDRAWAL_OTP_BATCH): Promise<WithdrawalOtpReport> {
  if (!(await ctx.sendingEnabled())) return { paused: true, outcomes: [] };
  const outcomes: WithdrawalOtpOutcome[] = [];
  const claimed = await claimWithdrawalOtpDeliveries(ctx.db, limit);
  for (const d of claimed) {
    try {
      if (d.email === null) {
        await recordWithdrawalOtpDelivery(ctx.db, d.challengeId, false, "email_not_verified");
        outcomes.push("email_not_verified");
        continue;
      }
      const code = (ctx.generate ?? generateWithdrawalOtp)();
      if (!(await recordWithdrawalOtpIssued(ctx.db, d.challengeId, hashWithdrawalOtp(ctx.secret, d.challengeId, code)))) {
        outcomes.push("superseded");
        continue;
      }
      try {
        await ctx.email.send({ idempotencyKey: `withdrawal-otp:${d.challengeId}`, message: withdrawalOtpEmail(d, code) });
      } catch (err) {
        const errorCode = typeof err === "object" && err !== null && "code" in err && typeof err.code === "string" ? err.code : "send_failed";
        await recordWithdrawalOtpDelivery(ctx.db, d.challengeId, false, errorCode);
        outcomes.push("delivery_failed");
        continue;
      }
      const status = await recordWithdrawalOtpDelivery(ctx.db, d.challengeId, true, null);
      outcomes.push(status === "sent" ? "sent" : "superseded");
    } catch {
      outcomes.push("error");
    }
  }
  return { paused: false, outcomes };
}

export function withdrawalOtpLogLine(report: WithdrawalOtpReport): Record<string, unknown> | null {
  if (report.outcomes.length === 0) return null;
  const counts: Record<string, number> = {};
  for (const o of report.outcomes) counts[o] = (counts[o] ?? 0) + 1;
  return { msg: "withdrawal_otp_delivery", examined: report.outcomes.length, ...counts };
}
