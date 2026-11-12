"use server";

import { isPaymentReference } from "@kolekto/domain";
import { confirmPayment, type ConfirmPaymentResult } from "@kolekto/payments";
import { getPaymentContext } from "../../../../../lib/payments/provider-factory.ts";

export async function verifyPaymentAction(reference: string): Promise<ConfirmPaymentResult> {
  if (typeof reference !== "string" || !isPaymentReference(reference)) {
    return { outcome: "not_found" };
  }

  const payments = getPaymentContext();
  if (!payments) return { outcome: "provider_unavailable", reason: "no_provider_configured" };

  return confirmPayment(payments, reference);
}
