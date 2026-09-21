/**
 * csv.ts — turning rows into a CSV file people can open.
 *
 * Separate and pure for the same reason `contribution.ts` is: the rules are
 * small, they are easy to get subtly wrong, and getting them wrong corrupts a
 * file rather than throwing. A name with a comma ("Obi, Ada"), an address with
 * a line break, a quoted nickname — each one splits a row into the wrong
 * number of columns in a spreadsheet if it is written out raw, and the person
 * reading it has no way to tell that it happened.
 *
 * RFC 4180, with the two additions a Nigerian export actually needs:
 *
 *   · a UTF-8 byte-order mark, because Excel on Windows reads a BOM-less file
 *     as the system codepage and turns ₦ into Ó¾ and "Adéṣínà" into mojibake
 *   · CRLF line endings, which is what RFC 4180 says and what Excel expects
 *
 * Nothing here knows what it is exporting. Columns are given, rows are given,
 * and what comes back is text.
 */

/** One column: the header a person reads, and how to get that cell out of a row. */
export interface CsvColumn<Row> {
  readonly header: string;
  readonly value: (row: Row) => string | number | null | undefined;
}

const BOM = "﻿";

/**
 * Quotes a single field if it needs it, and doubles any quotes inside.
 *
 * A leading `=`, `+`, `-` or `@` is also quoted and prefixed with a single
 * quote: spreadsheets treat those as the start of a formula, so a member
 * whose name or note begins with one becomes executable content in someone
 * else's Excel. That is CSV injection, and an export of member data is
 * exactly the file it travels in.
 */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";

  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;

  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

/** Rows and columns to a complete CSV file, headers included. */
export function toCsv<Row>(columns: readonly CsvColumn<Row>[], rows: readonly Row[]): string {
  const lines: string[] = [columns.map((column) => csvField(column.header)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvField(column.value(row))).join(","));
  }
  // Trailing CRLF: a file that ends without one makes some readers drop the
  // last row.
  return BOM + lines.join("\r\n") + "\r\n";
}

/**
 * A filename safe on every platform people open these on.
 *
 * Windows refuses `\ / : * ? " < > |`, and a colon in a timestamp is the
 * usual way an export lands as "download" with no extension.
 */
export function csvFilename(parts: readonly string[], on: Date): string {
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
  return `${stem || "export"}.csv`;
}
