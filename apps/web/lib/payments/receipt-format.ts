/**
 * receipt-format.ts — one description of what a payment receipt says, used by
 * the receipt on the callback page, the receipt page and the PDF, so the three
 * can never disagree.
 *
 * Pure. Amounts arrive as integer-kobo digit strings and are formatted with
 * the domain's integer formatter (never a float). Fee lines are shown only
 * when the contributor paid them (contributor_pays): when the host absorbs the
 * fees the contributor paid exactly the contribution, and the host's costs are
 * not the contributor's business. Labels follow D-28 ("Processing fee",
 * "Kolekto fee") and never name the provider.
 */

import type { PaymentReceipt } from "@kolekto/db";
import { formatNaira, kobo } from "@kolekto/domain";

export interface ReceiptRow {
  readonly label: string;
  readonly value: string;
  readonly emphasis?: boolean;
}

export interface ReceiptLineItem {
  readonly description: string;
  readonly amount: string;
}

export interface FormattedReceipt {
  readonly title: string;
  readonly communityName: string;
  readonly collectionName: string;
  readonly reference: string;
  readonly paidOn: string;
  readonly payer: ReceiptRow[];
  readonly items: ReceiptLineItem[];
  readonly amounts: ReceiptRow[];
  readonly note: string;
}

const CHANNEL_LABELS: Readonly<Record<string, string>> = {
  card: "Card",
  bank_transfer: "Bank transfer",
  bank: "Bank",
  ussd: "USSD",
  mobile_money: "Mobile money",
  qr: "QR",
};

function naira(raw: string): string {
  return /^[0-9]{1,18}$/.test(raw) ? formatNaira(kobo(raw)) : "—";
}

/** "16 November 2026, 9:42 am" in Africa/Lagos — the clock every reader is on. */
export function formatReceiptDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Africa/Lagos",
  }).format(d);
}

export function formatReceipt(r: PaymentReceipt): FormattedReceipt {
  const payer: ReceiptRow[] = [{ label: "Paid by", value: r.contributor_name }];
  if (r.contributor_email_masked) payer.push({ label: "Email", value: r.contributor_email_masked });
  const channel = r.channel ? CHANNEL_LABELS[r.channel] : undefined;
  if (channel) payer.push({ label: "Paid with", value: channel });

  const items: ReceiptLineItem[] =
    r.lines.length > 0
      ? r.lines.map((l) => ({
          description: `${l.name ?? "Item"}${l.quantity > 1 ? ` × ${l.quantity}` : ""}`,
          amount: naira(l.amount_kobo),
        }))
      : [{ description: r.collection_name, amount: naira(r.contribution_kobo) }];

  const amounts: ReceiptRow[] = [{ label: "Contribution", value: naira(r.contribution_kobo) }];
  if (r.fee_bearer === "contributor_pays") {
    if (r.gateway_fee_kobo !== "0") amounts.push({ label: "Processing fee", value: naira(r.gateway_fee_kobo) });
    if (r.platform_fee_kobo !== "0") amounts.push({ label: "Kolekto fee", value: naira(r.platform_fee_kobo) });
    if (r.vat_kobo !== "0") amounts.push({ label: "VAT", value: naira(r.vat_kobo) });
  }
  amounts.push({ label: "Total paid", value: naira(r.amount_kobo), emphasis: true });

  return {
    title: "Payment receipt",
    communityName: r.community_name,
    collectionName: r.collection_name,
    reference: r.reference,
    paidOn: formatReceiptDateTime(r.paid_at),
    payer,
    items,
    amounts,
    note: "Keep this receipt. Quote the reference if you contact the organiser about this payment.",
  };
}

/** The download name: "kolekto-receipt-KLK-….pdf". The reference is [A-Z0-9-] only. */
export function receiptFilename(reference: string): string {
  return `kolekto-receipt-${reference.replace(/[^A-Z0-9-]/g, "")}.pdf`;
}
