import "server-only";

/**
 * receipt.ts — the one server-side way to read a payment receipt.
 *
 * The KLK reference is the bearer secret (128 random bits, §4.4): whoever
 * holds it — the payer, through Paystack's redirect or their receipt email —
 * may see the receipt. The receipt itself is redacted at the database (email
 * masked, phone never returned). The URL's community and collection slugs
 * must be the payment's own, so a reference cannot be shown under another
 * collection's name.
 */

import { getPaymentReceipt, ownerPaymentDb, type PaymentReceipt } from "@kolekto/db";
import { isPaymentReference } from "@kolekto/domain";

export async function loadReceipt(
  communitySlug: string,
  collectionSlug: string,
  reference: string | null | undefined,
): Promise<PaymentReceipt | null> {
  if (typeof reference !== "string" || !isPaymentReference(reference)) return null;
  const receipt = await getPaymentReceipt(ownerPaymentDb, reference);
  if (!receipt) return null;
  if (receipt.community_slug !== communitySlug || receipt.collection_slug !== collectionSlug) return null;
  return receipt;
}

/** The PDF download path for a receipt, relative to the site. */
export function receiptPdfPath(communitySlug: string, collectionSlug: string, reference: string): string {
  return `/${encodeURIComponent(communitySlug)}/${encodeURIComponent(collectionSlug)}/payment/receipt/pdf?reference=${encodeURIComponent(reference)}`;
}
