import "server-only";

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";

import type { FormattedReceipt } from "../payments/receipt-format.ts";
import { drawable, loadFont } from "./report.ts";

/**
 * A payment receipt as a one-page A4 PDF, drawn on the server.
 *
 * Same font discipline as report.ts (DejaVu Sans embedded and subset, so ₦ and
 * Yoruba/Igbo letters print; anything the font cannot draw is substituted, not
 * thrown). The content is exactly what receipt-format.ts says, so the PDF and
 * the page always agree.
 */

const A4_W = 595.28;
const A4_H = 841.89;
const MARGIN = 56;
const INK = rgb(0.07, 0.07, 0.09);
const MUTED = rgb(0.42, 0.44, 0.5);
const RULE = rgb(0.8, 0.82, 0.86);

interface Fonts {
  readonly regular: PDFFont;
  readonly bold: PDFFont;
}

function text(page: PDFPage, value: string, x: number, y: number, size: number, font: PDFFont, color = INK): void {
  page.drawText(drawable(value), { x, y, size, font, color });
}

function right(page: PDFPage, value: string, xRight: number, y: number, size: number, font: PDFFont, color = INK): void {
  const safe = drawable(value);
  page.drawText(safe, { x: xRight - font.widthOfTextAtSize(safe, size), y, size, font, color });
}

function rule(page: PDFPage, y: number): void {
  page.drawLine({ start: { x: MARGIN, y }, end: { x: A4_W - MARGIN, y }, thickness: 0.6, color: RULE });
}

/** Shorten to fit the width, measured in the font that draws it. */
function fit(font: PDFFont, size: number, value: string, maxWidth: number): string {
  let s = drawable(value);
  while (s.length > 1 && font.widthOfTextAtSize(s, size) > maxWidth) s = `${s.slice(0, -2)}…`;
  return s;
}

export async function renderReceiptPdf(receipt: FormattedReceipt): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const fonts: Fonts = {
    regular: await pdf.embedFont(loadFont("DejaVuSans.ttf"), { subset: true }),
    bold: await pdf.embedFont(loadFont("DejaVuSans-Bold.ttf"), { subset: true }),
  };
  const page = pdf.addPage([A4_W, A4_H]);
  const contentRight = A4_W - MARGIN;
  const width = contentRight - MARGIN;
  let y = A4_H - MARGIN;

  text(page, "Kolekto", MARGIN, y - 4, 12, fonts.bold, MUTED);
  right(page, receipt.title.toUpperCase(), contentRight, y - 4, 12, fonts.bold, MUTED);
  y -= 40;

  text(page, fit(fonts.bold, 20, receipt.collectionName, width), MARGIN, y, 20, fonts.bold);
  y -= 22;
  text(page, fit(fonts.regular, 12, receipt.communityName, width), MARGIN, y, 12, fonts.regular, MUTED);
  y -= 30;

  const meta: [string, string][] = [
    ["Reference", receipt.reference],
    ["Date", receipt.paidOn],
    ...receipt.payer.map((r): [string, string] => [r.label, r.value]),
  ];
  for (const [label, value] of meta) {
    text(page, label, MARGIN, y, 10, fonts.regular, MUTED);
    text(page, fit(fonts.regular, 11, value, width - 120), MARGIN + 120, y, 11, fonts.regular);
    y -= 18;
  }
  y -= 10;
  rule(page, y);
  y -= 22;

  text(page, "Description", MARGIN, y, 10, fonts.bold, MUTED);
  right(page, "Amount", contentRight, y, 10, fonts.bold, MUTED);
  y -= 18;
  for (const item of receipt.items) {
    if (y < MARGIN + 160) break; // a one-page receipt: never draw into the footer
    text(page, fit(fonts.regular, 11, item.description, width - 140), MARGIN, y, 11, fonts.regular);
    right(page, item.amount, contentRight, y, 11, fonts.regular);
    y -= 18;
  }
  y -= 6;
  rule(page, y);
  y -= 22;

  for (const row of receipt.amounts) {
    const font = row.emphasis ? fonts.bold : fonts.regular;
    const size = row.emphasis ? 13 : 11;
    text(page, row.label, MARGIN + width / 2, y, size, font, row.emphasis ? INK : MUTED);
    right(page, row.value, contentRight, y, size, font);
    y -= row.emphasis ? 24 : 18;
  }

  y -= 20;
  text(page, fit(fonts.regular, 9, receipt.note, width), MARGIN, y, 9, fonts.regular, MUTED);
  text(page, "Issued by Kolekto on behalf of the organiser named above.", MARGIN, MARGIN, 9, fonts.regular, MUTED);

  pdf.setTitle(drawable(`${receipt.title} ${receipt.reference}`));
  pdf.setProducer("Kolekto");
  pdf.setCreator("Kolekto");
  return pdf.save();
}
