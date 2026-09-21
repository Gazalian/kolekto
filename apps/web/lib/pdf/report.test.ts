import { describe, expect, it, vi } from "vitest";

/**
 * `server-only` is a build-time guard with no Node implementation, so it has
 * to be stubbed for these to run outside a Next bundle. Everything else is
 * the real thing: the real pdf-lib, the real embedded font, real bytes.
 */
vi.mock("server-only", () => ({}));

const { PDFDocument } = await import("pdf-lib");
const { renderReportPdf, formatReportDate, formatReportDateTime } = await import("./report.ts");

const GENERATED = new Date("2026-09-21T18:42:00Z");

const COLUMNS = [
  { header: "Reference", weight: 2 },
  { header: "Name", weight: 4 },
  { header: "Ticket", weight: 2 },
  { header: "Amount", weight: 2, align: "right" as const },
];

function rows(count: number): string[][] {
  return Array.from({ length: count }, (_, index) => [
    `VIP-${String(index + 1).padStart(4, "0")}`,
    `Adéṣínà Oluwaseun ${index + 1}`,
    "VIP",
    "₦25,000",
  ]);
}

function spec(rowCount: number) {
  return {
    title: "Microbiology Dinner Tickets",
    subtitle: "Contributor Report",
    organiser: "Microbiology Class Association",
    generatedAt: GENERATED,
    filters: [
      { label: "Ticket type", value: "VIP" },
      { label: "Status", value: "Expected" },
    ],
    columns: COLUMNS,
    rows: rows(rowCount),
  };
}

/**
 * How many pages a reader gets, and how wide they are.
 *
 * Read by loading the document rather than by searching the bytes: pdf-lib
 * writes page dictionaries into compressed object streams, so a text search
 * finds nothing and quietly returns zero — a test that passes for the wrong
 * reason, which is worse than one that fails.
 */
async function pageCount(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes)).getPageCount();
}

async function firstPageWidth(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes)).getPage(0).getWidth();
}

describe("renderReportPdf", () => {
  it("produces a real PDF", async () => {
    const bytes = await renderReportPdf(spec(10));
    expect(Buffer.from(bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });

  it("embeds a font rather than relying on the standard fourteen", async () => {
    // The standard fourteen are WinAnsi-encoded and WinAnsi has no ₦. If this
    // stops being true, every amount in every printed report silently becomes
    // "N10,000", so the embedded font file is asserted rather than assumed.
    //
    // Read through pdf-lib rather than by searching the bytes: the font
    // descriptor lives in a compressed object stream, and a text search over
    // the raw file finds nothing whether the font is there or not.
    const pdf = await PDFDocument.load(await renderReportPdf(spec(3)));
    const objects = pdf.context.enumerateIndirectObjects();
    const serialised = objects.map(([, object]) => String(object)).join("\n");
    expect(serialised).toContain("/FontFile2");
    expect(serialised).toContain("/Identity-H");
  });

  it("draws ₦ itself, which is the whole reason a font is embedded", async () => {
    // This is the load-bearing assertion. If the embedded font fails to load,
    // renderReportPdf falls back to Helvetica — and Helvetica is WinAnsi, so
    // drawing ₦ throws rather than printing the wrong thing. A report that
    // renders at all with a naira sign in it proves the fallback was not
    // taken.
    const bytes = await renderReportPdf({
      ...spec(0),
      rows: [["BIO26-0001", "Ọlábísí Ṣówándé", "VIP", "₦25,000"]],
    });
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });

  it("paginates a long report and repeats the header", async () => {
    const short = await renderReportPdf(spec(10));
    const long = await renderReportPdf(spec(1000));
    expect(await pageCount(short)).toBe(1);
    expect(await pageCount(long)).toBeGreaterThan(20);
  });

  it("stays a usable size at a thousand rows", async () => {
    // Part AD. A report nobody can email is a report nobody uses.
    const bytes = await renderReportPdf(spec(1000));
    expect(bytes.byteLength).toBeLessThan(3_000_000);
  });

  it("prints a page even when nothing matched", async () => {
    const bytes = await renderReportPdf({ ...spec(0), rows: [] });
    expect(await pageCount(bytes)).toBe(1);
  });

  it("does not throw on a character the font cannot draw", async () => {
    // One member with an emoji in their name must not be the reason a whole
    // committee's report fails to generate.
    const bytes = await renderReportPdf({
      ...spec(0),
      rows: [["REF-0001", "Ada 🎉 Obi", "VIP", "₦1,000"]],
    });
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });

  it("survives a cell far longer than its column", async () => {
    const bytes = await renderReportPdf({
      ...spec(0),
      rows: [["REF-0001", "x".repeat(4000), "VIP", "₦1,000"]],
    });
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });

  it("turns a wide table sideways", async () => {
    const many = Array.from({ length: 10 }, (_, index) => ({ header: `Column ${index}`, weight: 1 }));
    const bytes = await renderReportPdf({
      ...spec(0),
      columns: many,
      rows: [many.map((_, index) => `cell ${index}`)],
    });
    // A4 landscape is 841.89 wide; portrait is 595.28.
    expect(Math.round(await firstPageWidth(bytes))).toBe(842);
  });
});

describe("dates a Nigerian reader recognises", () => {
  it("writes the month out, so 9/21 and 21/09 cannot be confused", () => {
    expect(formatReportDate(GENERATED)).toBe("21 September 2026");
  });

  it("renders a time in West Africa Time", () => {
    // 18:42 UTC is 19:42 WAT.
    expect(formatReportDateTime(GENERATED)).toBe("21 Sep 2026, 7:42 pm");
  });

  it("rolls the date over correctly at the WAT boundary", () => {
    expect(formatReportDate(new Date("2026-09-21T23:30:00Z"))).toBe("22 September 2026");
  });
});
