import "server-only";

import { readFileSync } from "node:fs";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import {
  chooseOrientation,
  distributeWidths,
  paginate,
  truncateToChars,
  type ReportColumn,
} from "@kolekto/domain";
import { REPORT_FONT_CODE_POINTS } from "./font-data.ts";

/**
 * A Kolekto report, as a PDF a person can print and hand round.
 *
 * M7.6 part G. The brief's instruction was "do not simply convert the CSV
 * into a badly formatted PDF", and the difference is structural rather than
 * decorative: a document has a heading that says what it is, the filters it
 * was produced under so the reader knows what is NOT in it, a table header
 * repeated on every page, and page numbers so a dropped sheet is noticed.
 *
 * WHERE THIS RUNS. On the server, always (part AD). A thousand-row PDF built
 * in a browser is a few tens of megabytes of JavaScript objects on a phone
 * that is already running the page; built here it is a byte array the browser
 * only saves. `server-only` makes that a build error rather than a habit.
 *
 * THE FONT. The fourteen standard PDF fonts are WinAnsi-encoded and WinAnsi
 * has no naira sign, so a report of Nigerian money drawn with Helvetica reads
 * "N10,000" — and WinAnsi cannot write ẹ, ọ, ṣ, ị or ụ either, which is to
 * say it cannot write a great many Nigerian names. So DejaVu Sans is
 * embedded, from ./fonts, and pdf-lib subsets it per document so the file
 * that comes out stays small. Helvetica is still loaded as a last resort, for
 * the case where the font file cannot be read: a report that prints with the
 * wrong currency symbol is bad, and a report that does not print at all is
 * worse.
 *
 * The font is read with `new URL(…, import.meta.url)`, which is the form
 * Next's file tracing recognises statically — a path assembled at runtime is
 * copied into the server bundle by luck rather than by rule.
 */

export interface PdfReportFilter {
  readonly label: string;
  readonly value: string;
}

export interface PdfReportSpec {
  /** "MICROBIOLOGY DINNER TICKETS" — what this is a report about. */
  readonly title: string;
  /** "Contributor Report" — what kind of report it is. */
  readonly subtitle: string;
  readonly organiser: string;
  readonly generatedAt: Date;
  /** What was asked for. Printed so the reader knows what the report leaves out. */
  readonly filters: readonly PdfReportFilter[];
  readonly columns: readonly ReportColumn[];
  readonly rows: readonly (readonly string[])[];
  /** One honest sentence under the table, e.g. what this report cannot yet contain. */
  readonly note?: string;
}

const A4_SHORT = 595.28;
const A4_LONG = 841.89;
const MARGIN = 40;

const INK = rgb(0.07, 0.07, 0.09);
const MUTED = rgb(0.42, 0.44, 0.5);
const RULE = rgb(0.8, 0.82, 0.86);
const BAND = rgb(0.96, 0.965, 0.98);

const TITLE_SIZE = 16;
const SUBTITLE_SIZE = 10;
const META_SIZE = 9;
const HEADER_SIZE = 9;
const CELL_SIZE = 9;
const ROW_HEIGHT = 18;
const HEADER_ROW_HEIGHT = 20;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * "21 September 2026". Written out rather than left to `toLocaleDateString`,
 * whose output depends on which ICU data the server happens to ship — a
 * report that reads 9/21/2026 in production and 21/09/2026 in development is
 * a report nobody trusts. Rendered in West Africa Time, which is the clock
 * every reader of this document is on.
 */
export function formatReportDate(on: Date): string {
  const wat = new Date(on.getTime() + 60 * 60 * 1000);
  return `${wat.getUTCDate()} ${MONTHS[wat.getUTCMonth()]} ${wat.getUTCFullYear()}`;
}

/** "21 Sep 2026, 7:42 pm" — for a check-in time, where the minute matters. */
export function formatReportDateTime(on: Date): string {
  const wat = new Date(on.getTime() + 60 * 60 * 1000);
  const hours = wat.getUTCHours();
  const suffix = hours < 12 ? "am" : "pm";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  const minutes = String(wat.getUTCMinutes()).padStart(2, "0");
  return `${wat.getUTCDate()} ${MONTHS[wat.getUTCMonth()]!.slice(0, 3)} ${wat.getUTCFullYear()}, ${hour12}:${minutes} ${suffix}`;
}

/**
 * Replaces anything the embedded font cannot draw.
 *
 * pdf-lib throws when asked to draw a character its font has no glyph for, so
 * without this one unusual character in one member's name is the reason a
 * whole report fails to generate. Losing a character is bad; losing the
 * report is worse, and the substitution is visible.
 */
function drawable(text: string): string {
  let safe = "";
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code === 0x0a || code === 0x0d || code === 0x09) {
      safe += " ";
    } else if (REPORT_FONT_CODE_POINTS.has(code)) {
      safe += character;
    } else {
      safe += "?";
    }
  }
  return safe;
}

/**
 * The font bytes, read once and kept.
 *
 * `new URL("./fonts/…", import.meta.url)` rather than a joined path: it is
 * the form Next's file tracer recognises statically, so the .ttf is copied
 * into the server bundle because the code says so, not because a glob
 * happened to catch it.
 */
const fontCache = new Map<string, Buffer>();
function loadFont(file: "DejaVuSans.ttf" | "DejaVuSans-Bold.ttf"): Buffer {
  const cached = fontCache.get(file);
  if (cached) return cached;
  const bytes = readFileSync(
    file === "DejaVuSans.ttf"
      ? new URL("./fonts/DejaVuSans.ttf", import.meta.url)
      : new URL("./fonts/DejaVuSans-Bold.ttf", import.meta.url),
  );
  fontCache.set(file, bytes);
  return bytes;
}

/** Shortens text until it actually fits the width, measured in the font that will draw it. */
function fit(font: PDFFont, size: number, text: string, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;

  // Start from a width-proportional guess so a 400-character cell does not
  // take 400 measurements to shrink.
  const perCharacter = font.widthOfTextAtSize(text, size) / Math.max([...text].length, 1);
  let candidate = truncateToChars(text, Math.max(Math.floor(maxWidth / perCharacter), 1));

  while (candidate.length > 1 && font.widthOfTextAtSize(candidate, size) > maxWidth) {
    candidate = truncateToChars(candidate, [...candidate].length - 1);
  }
  return font.widthOfTextAtSize(candidate, size) <= maxWidth ? candidate : "";
}

export async function renderReportPdf(spec: PdfReportSpec): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);

  let regular: PDFFont;
  let bold: PDFFont;
  try {
    regular = await pdf.embedFont(loadFont("DejaVuSans.ttf"), { subset: true });
    bold = await pdf.embedFont(loadFont("DejaVuSans-Bold.ttf"), { subset: true });
  } catch {
    // The font file could not be read or parsed. Print with the standard one
    // rather than failing — `drawable` has already replaced anything outside
    // the supported set, so what lands on the page is legible, if not ideal.
    regular = await pdf.embedFont(StandardFonts.Helvetica);
    bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  }

  const orientation = chooseOrientation(spec.columns.length);
  const pageWidth = orientation === "landscape" ? A4_LONG : A4_SHORT;
  const pageHeight = orientation === "landscape" ? A4_SHORT : A4_LONG;
  const contentWidth = pageWidth - MARGIN * 2;

  const widths = distributeWidths(spec.columns, contentWidth, 44);

  // How tall the heading block is, so the first page's row capacity accounts
  // for it rather than running rows under the title.
  const filterLines = spec.filters.length === 0 ? 0 : spec.filters.length + 1;
  const headingHeight = 30 + TITLE_SIZE + 6 + SUBTITLE_SIZE + 8 + META_SIZE * 2 + 10 + filterLines * (META_SIZE + 3);

  const footerHeight = 28 + (spec.note ? META_SIZE + 8 : 0);
  const tableTopFirst = pageHeight - MARGIN - headingHeight;
  const tableTopLater = pageHeight - MARGIN;
  const tableBottom = MARGIN + footerHeight;

  const firstPageRows = Math.floor((tableTopFirst - HEADER_ROW_HEIGHT - tableBottom) / ROW_HEIGHT);
  const laterPageRows = Math.floor((tableTopLater - HEADER_ROW_HEIGHT - tableBottom) / ROW_HEIGHT);

  const slices = paginate(spec.rows.length, firstPageRows, laterPageRows);

  slices.forEach((slice, index) => {
    const page = pdf.addPage([pageWidth, pageHeight]);
    let y = pageHeight - MARGIN;

    if (index === 0) {
      y = drawHeading(page, spec, { bold, regular }, y, contentWidth);
    }

    y = drawTableHeader(page, spec.columns, widths, bold, y, contentWidth);

    for (let row = slice.startIndex; row < slice.endIndex; row += 1) {
      y = drawRow(page, spec.columns, widths, regular, y, spec.rows[row]!, row % 2 === 1, contentWidth);
    }

    if (slice.startIndex === slice.endIndex) {
      page.drawText(drawable("Nothing matched the filters above."), {
        x: MARGIN,
        y: y - 14,
        size: CELL_SIZE,
        font: regular,
        color: MUTED,
      });
    }

    drawFooter(page, spec, regular, slice.pageNumber, slices.length, pageWidth);
  });

  pdf.setTitle(drawable(`${spec.title} — ${spec.subtitle}`));
  pdf.setProducer("Kolekto");
  pdf.setCreator("Kolekto");
  pdf.setCreationDate(spec.generatedAt);

  return pdf.save();
}

function drawHeading(
  page: PDFPage,
  spec: PdfReportSpec,
  fonts: { bold: PDFFont; regular: PDFFont },
  top: number,
  contentWidth: number,
): number {
  let y = top;

  page.drawText("KOLEKTO", { x: MARGIN, y: y - 10, size: 10, font: fonts.bold, color: MUTED });
  y -= 30;

  page.drawText(fit(fonts.bold, TITLE_SIZE, drawable(spec.title.toUpperCase()), contentWidth), {
    x: MARGIN,
    y: y - TITLE_SIZE,
    size: TITLE_SIZE,
    font: fonts.bold,
    color: INK,
  });
  y -= TITLE_SIZE + 6;

  page.drawText(fit(fonts.regular, SUBTITLE_SIZE, drawable(spec.subtitle), contentWidth), {
    x: MARGIN,
    y: y - SUBTITLE_SIZE,
    size: SUBTITLE_SIZE,
    font: fonts.regular,
    color: MUTED,
  });
  y -= SUBTITLE_SIZE + 8;

  for (const line of [`Organizer: ${spec.organiser}`, `Generated: ${formatReportDate(spec.generatedAt)}`]) {
    page.drawText(fit(fonts.regular, META_SIZE, drawable(line), contentWidth), {
      x: MARGIN,
      y: y - META_SIZE,
      size: META_SIZE,
      font: fonts.regular,
      color: INK,
    });
    y -= META_SIZE + 2;
  }

  if (spec.filters.length > 0) {
    y -= 6;
    page.drawText("Filters", { x: MARGIN, y: y - META_SIZE, size: META_SIZE, font: fonts.bold, color: INK });
    y -= META_SIZE + 3;
    for (const filter of spec.filters) {
      page.drawText(
        fit(fonts.regular, META_SIZE, drawable(`${filter.label}: ${filter.value}`), contentWidth),
        { x: MARGIN, y: y - META_SIZE, size: META_SIZE, font: fonts.regular, color: MUTED },
      );
      y -= META_SIZE + 3;
    }
  }

  return y - 10;
}

function drawTableHeader(
  page: PDFPage,
  columns: readonly ReportColumn[],
  widths: readonly number[],
  bold: PDFFont,
  top: number,
  contentWidth: number,
): number {
  const baseline = top - HEADER_ROW_HEIGHT + 6;

  page.drawLine({
    start: { x: MARGIN, y: top },
    end: { x: MARGIN + contentWidth, y: top },
    thickness: 0.8,
    color: INK,
  });

  let x = MARGIN;
  columns.forEach((column, index) => {
    const width = widths[index]!;
    const text = fit(bold, HEADER_SIZE, drawable(column.header), width - 8);
    const offset =
      column.align === "right" ? width - 4 - bold.widthOfTextAtSize(text, HEADER_SIZE) : 4;
    page.drawText(text, { x: x + offset, y: baseline, size: HEADER_SIZE, font: bold, color: INK });
    x += width;
  });

  const bottom = top - HEADER_ROW_HEIGHT;
  page.drawLine({
    start: { x: MARGIN, y: bottom },
    end: { x: MARGIN + contentWidth, y: bottom },
    thickness: 0.5,
    color: RULE,
  });

  return bottom;
}

function drawRow(
  page: PDFPage,
  columns: readonly ReportColumn[],
  widths: readonly number[],
  regular: PDFFont,
  top: number,
  cells: readonly string[],
  banded: boolean,
  contentWidth: number,
): number {
  if (banded) {
    page.drawRectangle({
      x: MARGIN,
      y: top - ROW_HEIGHT,
      width: contentWidth,
      height: ROW_HEIGHT,
      color: BAND,
    });
  }

  const baseline = top - ROW_HEIGHT + 6;
  let x = MARGIN;
  columns.forEach((column, index) => {
    const width = widths[index]!;
    const text = fit(regular, CELL_SIZE, drawable(cells[index] ?? ""), width - 8);
    const offset =
      column.align === "right" ? width - 4 - regular.widthOfTextAtSize(text, CELL_SIZE) : 4;
    page.drawText(text, { x: x + offset, y: baseline, size: CELL_SIZE, font: regular, color: INK });
    x += width;
  });

  return top - ROW_HEIGHT;
}

function drawFooter(
  page: PDFPage,
  spec: PdfReportSpec,
  regular: PDFFont,
  pageNumber: number,
  pageCount: number,
  pageWidth: number,
): void {
  const contentWidth = pageWidth - MARGIN * 2;
  let y = MARGIN;

  if (spec.note) {
    page.drawText(fit(regular, META_SIZE, drawable(spec.note), contentWidth), {
      x: MARGIN,
      y: y + 16,
      size: META_SIZE,
      font: regular,
      color: MUTED,
    });
    y += 0;
  }

  page.drawLine({
    start: { x: MARGIN, y: y + 12 },
    end: { x: MARGIN + contentWidth, y: y + 12 },
    thickness: 0.5,
    color: RULE,
  });

  page.drawText(drawable(`${spec.organiser} · ${spec.rows.length} row${spec.rows.length === 1 ? "" : "s"}`), {
    x: MARGIN,
    y: y,
    size: META_SIZE,
    font: regular,
    color: MUTED,
  });

  const label = `Page ${pageNumber} of ${pageCount}`;
  page.drawText(label, {
    x: MARGIN + contentWidth - regular.widthOfTextAtSize(label, META_SIZE),
    y: y,
    size: META_SIZE,
    font: regular,
    color: MUTED,
  });
}
