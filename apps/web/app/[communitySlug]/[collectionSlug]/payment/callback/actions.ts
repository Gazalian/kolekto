"use server";

import { isPaymentReference } from "@kolekto/domain";
import { confirmPayment, type ConfirmPaymentResult } from "@kolekto/payments";
import { getPaymentContext } from "../../../../../lib/payments/provider-factory.ts";
import { loadReceipt, receiptPdfPath } from "../../../../../lib/payments/receipt.ts";
import { formatReceipt, type FormattedReceipt } from "../../../../../lib/payments/receipt-format.ts";

export async function verifyPaymentAction(reference: string): Promise<ConfirmPaymentResult> {
  if (typeof reference !== "string" || !isPaymentReference(reference)) {
    return { outcome: "not_found" };
  }

  const payments = getPaymentContext();
  if (!payments) return { outcome: "provider_unavailable", reason: "no_provider_configured" };

  return confirmPayment(payments, reference);
}

/**
 * The receipt for a completed payment, formatted for the page, with its PDF
 * link. Null unless the payment is completed and belongs to this collection.
 * Reads the database only.
 */
export async function receiptAction(
  communitySlug: string,
  collectionSlug: string,
  reference: string,
): Promise<{ receipt: FormattedReceipt; pdfHref: string } | null> {
  if (typeof communitySlug !== "string" || typeof collectionSlug !== "string") return null;
  const receipt = await loadReceipt(communitySlug, collectionSlug, reference);
  if (!receipt) return null;
  return { receipt: formatReceipt(receipt), pdfHref: receiptPdfPath(communitySlug, collectionSlug, receipt.reference) };
}
