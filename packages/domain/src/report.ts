/**
 * report.ts — the decisions a printed report makes, without the drawing.
 *
 * The PDF writer lives in the web app because it needs a font and a byte
 * buffer. Everything it has to get RIGHT is here, where it can be tested
 * without producing a file and opening it:
 *
 *   · how many rows fit on the first page, which is shorter because the
 *     heading and the filters sit above the table
 *   · how many fit on every page after it
 *   · which page each row lands on, so a 1,000-row export is 1,000 rows and
 *     not 997 with three lost at a page boundary
 *   · how wide each column is when the table is wider than the paper
 *   · whether a table with many columns should be turned sideways
 *
 * Every one of those is an off-by-one waiting to happen, and every one of
 * them is invisible until somebody prints an attendance list and finds three
 * people missing from it.
 *
 * Pure: no clock, no I/O, no font metrics. Widths are in characters, which is
 * an approximation the caller converts to points — good enough for column
 * proportions, and the renderer measures the real glyphs before it draws.
 */

export interface ReportColumn {
  readonly header: string;
  /** How much of the available width this column wants, relative to the others. */
  readonly weight: number;
  readonly align?: "left" | "right";
}

export interface ReportPageSlice {
  readonly pageNumber: number;
  readonly startIndex: number;
  /** Exclusive. */
  readonly endIndex: number;
}

/**
 * Which rows go on which page.
 *
 * The first page holds fewer, because the report's heading, the organiser,
 * the generated date and the filters are printed above the table. Every later
 * page starts with a repeated header row and nothing else.
 *
 * A report with no rows still produces one page: "nobody matched these
 * filters" is a result worth printing, and an empty PDF is a bug report.
 */
export function paginate(
  rowCount: number,
  firstPageRows: number,
  laterPageRows: number,
): ReportPageSlice[] {
  const first = Math.max(1, Math.trunc(firstPageRows));
  const later = Math.max(1, Math.trunc(laterPageRows));
  const total = Math.max(0, Math.trunc(rowCount));

  if (total === 0) {
    return [{ pageNumber: 1, startIndex: 0, endIndex: 0 }];
  }

  const pages: ReportPageSlice[] = [];
  let index = 0;
  while (index < total) {
    const capacity = pages.length === 0 ? first : later;
    const end = Math.min(total, index + capacity);
    pages.push({ pageNumber: pages.length + 1, startIndex: index, endIndex: end });
    index = end;
  }
  return pages;
}

/**
 * Column widths that add up to exactly the width available.
 *
 * Proportional to the weights, with a floor so a narrow column never
 * collapses to nothing, and with the rounding remainder given to the widest
 * column rather than dropped — a table whose columns do not reach the right
 * margin looks like a rendering fault even when every cell is correct.
 */
export function distributeWidths(
  columns: readonly ReportColumn[],
  available: number,
  minimum = 24,
): number[] {
  if (columns.length === 0) return [];

  // If even the floors do not fit, everything is the same width and the
  // renderer's own truncation deals with the consequences.
  if (columns.length * minimum >= available) {
    const each = available / columns.length;
    return columns.map(() => each);
  }

  const totalWeight = columns.reduce((sum, column) => sum + Math.max(column.weight, 0), 0);
  if (totalWeight <= 0) {
    const each = available / columns.length;
    return columns.map(() => each);
  }

  const raw = columns.map((column) => Math.max((Math.max(column.weight, 0) / totalWeight) * available, minimum));
  const rawTotal = raw.reduce((sum, width) => sum + width, 0);

  // Floors pushed the total over. Take the excess back from the columns that
  // are above the floor, in proportion to how far above it they are.
  if (rawTotal > available) {
    const slack = raw.map((width) => width - minimum);
    const totalSlack = slack.reduce((sum, value) => sum + value, 0);
    const excess = rawTotal - available;
    if (totalSlack <= 0) {
      const each = available / columns.length;
      return columns.map(() => each);
    }
    return raw.map((width, index) => width - (slack[index]! / totalSlack) * excess);
  }

  const widths = [...raw];
  const remainder = available - rawTotal;
  if (remainder !== 0) {
    let widest = 0;
    for (let index = 1; index < widths.length; index += 1) {
      if (widths[index]! > widths[widest]!) widest = index;
    }
    widths[widest] = widths[widest]! + remainder;
  }
  return widths;
}

/**
 * A table this wide does not belong on a portrait page.
 *
 * Six columns is the point at which A4 portrait starts truncating names, and
 * a truncated name in an attendance list is worse than a sideways page.
 */
export function chooseOrientation(columnCount: number): "portrait" | "landscape" {
  return columnCount > 6 ? "landscape" : "portrait";
}

/**
 * Shortens a cell to fit, ending with a single-character ellipsis so the
 * reader can see that something was cut rather than believing the short name.
 */
export function truncateToChars(text: string, maxChars: number): string {
  const limit = Math.trunc(maxChars);
  if (limit <= 0) return "";
  const characters = [...text];
  if (characters.length <= limit) return text;
  if (limit === 1) return "…";
  return characters.slice(0, limit - 1).join("") + "…";
}

/**
 * The filename a report downloads as.
 *
 * Same rules as `csvFilename` — Windows refuses `\ / : * ? " < > |`, and a
 * colon out of a timestamp is the usual reason a download lands with no
 * extension — with the extension as a parameter, because this one is used for
 * both .csv and .pdf.
 */
export function reportFilename(parts: readonly string[], on: Date, extension: string): string {
  const stamp = on.toISOString().slice(0, 10);
  const stem = [...parts, stamp]
    .map((part) =>
      part
        .normalize("NFKD")
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .toLowerCase(),
    )
    .filter((part) => part !== "")
    .join("-");
  return `${stem || "report"}.${extension}`;
}
