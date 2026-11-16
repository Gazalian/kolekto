import { notFound } from "next/navigation";

import { loadReceipt, receiptPdfPath } from "../../../../../lib/payments/receipt.ts";
import { formatReceipt } from "../../../../../lib/payments/receipt-format.ts";
import { ReceiptView } from "../ReceiptView.tsx";

/**
 * /{community}/{collection}/payment/receipt?reference=KLK-…
 *
 * The page the receipt email links to. Reads the database only: unlike the
 * callback page it never asks the provider to verify, so opening an old
 * email again costs nothing and changes nothing. A payment that is not
 * completed, an unknown reference, or a reference from another collection
 * is a 404 — the page confirms nothing to someone without the receipt.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Payment receipt",
  robots: { index: false, follow: false },
};

export default async function PaymentReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ communitySlug: string; collectionSlug: string }>;
  searchParams: Promise<{ reference?: string }>;
}) {
  const { communitySlug, collectionSlug } = await params;
  const { reference } = await searchParams;
  const receipt = await loadReceipt(communitySlug, collectionSlug, reference);
  if (!receipt) notFound();

  return (
    <main className="flex min-h-svh flex-col items-center justify-start bg-[var(--color-bg)] px-4 pt-16 pb-12 sm:pt-24">
      <div className="w-full max-w-md">
        <ReceiptView receipt={formatReceipt(receipt)} pdfHref={receiptPdfPath(communitySlug, collectionSlug, receipt.reference)} />
        <p className="mt-8 text-center text-xs text-[var(--color-text-faint)]">
          Secured by Kolekto
        </p>
      </div>
    </main>
  );
}
