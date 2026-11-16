import "server-only";

/**
 * GET /{community}/{collection}/payment/receipt/pdf?reference=KLK-…
 *
 * The receipt as a PDF download. Same read and same rules as the receipt
 * page (lib/payments/receipt.ts): completed payments only, slugs must be the
 * payment's own, anything else is a plain 404 that confirms nothing. Never
 * cached anywhere: the response carries the payer's name.
 *
 * Logs nothing (no reference, no name).
 */

import { loadReceipt } from "../../../../../../lib/payments/receipt.ts";
import { formatReceipt, receiptFilename } from "../../../../../../lib/payments/receipt-format.ts";
import { renderReceiptPdf } from "../../../../../../lib/pdf/receipt.ts";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ communitySlug: string; collectionSlug: string }> },
): Promise<Response> {
  const { communitySlug, collectionSlug } = await params;
  const reference = new URL(request.url).searchParams.get("reference");
  const receipt = await loadReceipt(communitySlug, collectionSlug, reference);
  if (!receipt) {
    return new Response("Not found\n", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const pdf = await renderReceiptPdf(formatReceipt(receipt));
  return new Response(Buffer.from(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${receiptFilename(receipt.reference)}"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
