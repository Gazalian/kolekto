import { describe, expect, it } from "vitest";
import type { PaymentReceipt } from "@kolekto/db";

import { formatReceipt, formatReceiptDateTime, receiptFilename } from "./receipt-format.ts";

const BASE: PaymentReceipt = {
  reference: "KLK-0123456789ABCDEFGHJKMNPQRS",
  community_name: "Biochem Class '26",
  community_slug: "biochem-26",
  collection_name: "Dinner",
  collection_slug: "dinner",
  contributor_name: "Adaeze Ọkọnkwọ",
  contributor_email_masked: "a***@example.com",
  amount_kobo: "255000",
  contribution_kobo: "250000",
  platform_fee_kobo: "1250",
  gateway_fee_kobo: "3750",
  vat_kobo: "0",
  total_fees_kobo: "5000",
  fee_bearer: "contributor_pays",
  paid_at: "2026-11-16T08:42:00.000Z",
  channel: "card",
  lines: [],
};

describe("formatReceipt", () => {
  it("contributor pays: contribution, processing and Kolekto fee lines, then the total; zero VAT hidden", () => {
    const r = formatReceipt(BASE);
    expect(r.amounts).toEqual([
      { label: "Contribution", value: "₦2,500.00" },
      { label: "Processing fee", value: "₦37.50" },
      { label: "Kolekto fee", value: "₦12.50" },
      { label: "Total paid", value: "₦2,550.00", emphasis: true },
    ]);
    expect(r.items).toEqual([{ description: "Dinner", amount: "₦2,500.00" }]);
    expect(r.payer).toEqual([
      { label: "Paid by", value: "Adaeze Ọkọnkwọ" },
      { label: "Email", value: "a***@example.com" },
      { label: "Paid with", value: "Card" },
    ]);
  });

  it("host absorbs: no fee lines; the total is the contribution", () => {
    const r = formatReceipt({ ...BASE, fee_bearer: "community_absorbs", amount_kobo: "250000" });
    expect(r.amounts.map((a) => a.label)).toEqual(["Contribution", "Total paid"]);
    expect(r.amounts.at(-1)!.value).toBe("₦2,500.00");
  });

  it("lists tier/item lines with quantities", () => {
    const r = formatReceipt({
      ...BASE,
      lines: [
        { name: "VIP", quantity: 2, unit_price_kobo: "100000", amount_kobo: "200000" },
        { name: "Regular", quantity: 1, unit_price_kobo: "50000", amount_kobo: "50000" },
      ],
    });
    expect(r.items).toEqual([
      { description: "VIP × 2", amount: "₦2,000.00" },
      { description: "Regular", amount: "₦500.00" },
    ]);
  });

  it("dates in Africa/Lagos", () => {
    expect(formatReceiptDateTime("2026-11-16T08:42:00.000Z")).toMatch(/16 November 2026.*9:42/);
    expect(formatReceiptDateTime("nope")).toBe("—");
  });

  it("builds a safe filename", () => {
    expect(receiptFilename(BASE.reference)).toBe("kolekto-receipt-KLK-0123456789ABCDEFGHJKMNPQRS.pdf");
    expect(receiptFilename('KLK-"; x')).toBe("kolekto-receipt-KLK-.pdf");
  });
});
