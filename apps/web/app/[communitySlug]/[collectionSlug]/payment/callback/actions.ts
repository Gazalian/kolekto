"use server";

import { isPaymentReference } from "@kolekto/domain";
import { confirmPayment, type ConfirmPaymentResult } from "../../../../../lib/payments/orchestrator.ts";
import { getPaymentProvider } from "../../../../../lib/payments/provider-factory.ts";

export async function verifyPaymentAction(reference: string): Promise<ConfirmPaymentResult> {
  if (typeof reference !== "string" || !isPaymentReference(reference)) {
    return { outcome: "not_found" };
  }

  return confirmPayment({
    reference,
    provider: getPaymentProvider(),
  });
}
