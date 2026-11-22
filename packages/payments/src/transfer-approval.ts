/**
 * transfer-approval.ts — Kolekto's answer to Paystack's transfer approval
 * request (server approval / "approval URL", owner decision 2026-11-19).
 *
 * Paystack calls the approval URL for each transfer request and waits a few
 * seconds: HTTP 200 approves (the transfer proceeds), HTTP 400 rejects
 * (`rejected`), no answer blocks it (`blocked`). Both rejected and blocked are
 * conclusive failures at Paystack — no money moves — which the normal verify
 * path later settles (hold released once).
 *
 * Fail closed: anything other than an explicit approval from
 * app.decide_transfer_approval — unreadable or inconsistent body, unknown
 * reference, bad signature, database error — is a 400. A body the parser
 * refuses is still sent to the database (one call) so the refusal is
 * recorded with its `payload_…` reason and linked to the transfer when its
 * reference could be read. Approval is not payment: only a verified provider
 * success settles a withdrawal.
 */

import { parseTransferApprovalRequest } from "@kolekto/adapters";
import { decideTransferApproval, type PaymentDb } from "@kolekto/db";

export interface TransferApprovalAnswer {
  readonly httpStatus: 200 | 400;
  readonly decision: "approve" | "reject";
  readonly reasonCode: string;
}

export async function answerTransferApproval(
  db: PaymentDb,
  rawBody: Uint8Array,
  signature: "valid" | "absent",
): Promise<TransferApprovalAnswer> {
  const parsed = parseTransferApprovalRequest(rawBody);
  try {
    const { decision, reasonCode } = await decideTransferApproval(
      db,
      parsed.ok
        ? {
            reference: parsed.request.reference,
            amountKobo: parsed.request.amountKobo,
            recipientCode: parsed.request.recipientCode,
            currency: parsed.request.currency,
            transferCode: parsed.request.transferCode,
            payloadRejection: null,
            signature,
          }
        : {
            reference: parsed.reference,
            amountKobo: null,
            recipientCode: null,
            currency: null,
            transferCode: null,
            payloadRejection: parsed.rejection,
            signature,
          },
    );
    // Belt and braces: a refused payload is never a 200, whatever the database says.
    if (!parsed.ok || decision !== "approve") return { httpStatus: 400, decision: "reject", reasonCode };
    return { httpStatus: 200, decision, reasonCode };
  } catch {
    return { httpStatus: 400, decision: "reject", reasonCode: "error" };
  }
}
