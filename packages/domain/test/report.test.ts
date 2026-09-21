import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chooseOrientation,
  distributeWidths,
  paginate,
  reportFilename,
  truncateToChars,
} from "../src/report.ts";

describe("paginate", () => {
  it("fills the short first page, then the full ones", () => {
    const pages = paginate(60, 20, 30);
    assert.deepEqual(
      pages.map((page) => [page.startIndex, page.endIndex]),
      [
        [0, 20],
        [20, 50],
        [50, 60],
      ],
    );
  });

  it("accounts for every row exactly once", () => {
    // The defect this exists to catch: an attendance list printed with three
    // people silently missing at a page boundary.
    for (const total of [1, 7, 29, 30, 31, 999, 1000, 1001]) {
      const pages = paginate(total, 22, 34);
      assert.equal(pages[0]!.startIndex, 0);
      assert.equal(pages.at(-1)!.endIndex, total, `last row of ${total} is on a page`);
      for (let index = 1; index < pages.length; index += 1) {
        assert.equal(pages[index]!.startIndex, pages[index - 1]!.endIndex, `no gap before page ${index + 1}`);
      }
      const counted = pages.reduce((sum, page) => sum + (page.endIndex - page.startIndex), 0);
      assert.equal(counted, total, `${total} rows printed, ${counted} counted`);
    }
  });

  it("numbers pages from one, consecutively", () => {
    const pages = paginate(100, 10, 10);
    assert.deepEqual(
      pages.map((page) => page.pageNumber),
      Array.from({ length: 10 }, (_, index) => index + 1),
    );
  });

  it("still produces a page when nothing matched", () => {
    const pages = paginate(0, 20, 30);
    assert.equal(pages.length, 1);
    assert.equal(pages[0]!.endIndex, 0);
  });

  it("does not spin forever on a nonsensical capacity", () => {
    const pages = paginate(5, 0, -3);
    assert.equal(pages.length, 5, "a capacity below one is treated as one row per page");
  });
});

describe("distributeWidths", () => {
  const columns = [
    { header: "Reference", weight: 2 },
    { header: "Name", weight: 4 },
    { header: "Status", weight: 1 },
  ];

  it("uses exactly the width available", () => {
    const widths = distributeWidths(columns, 700);
    assert.equal(
      Math.round(widths.reduce((sum, width) => sum + width, 0)),
      700,
      "a table that stops short of the margin reads as a rendering fault",
    );
  });

  it("keeps the proportions when nothing hits the floor", () => {
    const widths = distributeWidths(columns, 700, 10);
    assert.equal(Math.round(widths[0]!), 200);
    assert.equal(Math.round(widths[1]!), 400);
    assert.equal(Math.round(widths[2]!), 100);
  });

  it("gives a starved column its floor and takes the difference from the others", () => {
    const widths = distributeWidths(columns, 700, 150);
    assert.ok(widths[2]! >= 149.9, "the narrow column is not allowed to collapse");
    assert.equal(Math.round(widths.reduce((sum, width) => sum + width, 0)), 700);
  });

  it("shares the page equally when the floors cannot all fit", () => {
    const widths = distributeWidths(columns, 60, 40);
    assert.equal(widths.length, 3);
    assert.equal(Math.round(widths.reduce((sum, width) => sum + width, 0)), 60);
  });

  it("has nothing to distribute across no columns", () => {
    assert.deepEqual(distributeWidths([], 700), []);
  });
});

describe("chooseOrientation", () => {
  it("turns a wide table sideways rather than truncating names", () => {
    assert.equal(chooseOrientation(4), "portrait");
    assert.equal(chooseOrientation(6), "portrait");
    assert.equal(chooseOrientation(7), "landscape");
    assert.equal(chooseOrientation(12), "landscape");
  });
});

describe("truncateToChars", () => {
  it("leaves what fits alone", () => {
    assert.equal(truncateToChars("Adéṣínà", 20), "Adéṣínà");
  });

  it("marks what it cut", () => {
    assert.equal(truncateToChars("Oluwaseun Adebayo", 10), "Oluwaseun…");
  });

  it("counts characters, not code units", () => {
    // "ṣ" is one character. A slice by code unit would cut a name in half and
    // leave a broken glyph on the paper.
    assert.equal([...truncateToChars("Ṣọlá Adéṣínà", 6)].length, 6);
  });

  it("handles the degenerate widths", () => {
    assert.equal(truncateToChars("anything", 0), "");
    assert.equal(truncateToChars("anything", 1), "…");
  });
});

describe("reportFilename", () => {
  it("is safe on Windows, which refuses a colon", () => {
    const name = reportFilename(["Ilorin Estate", "Dinner: 2026"], new Date("2026-09-21T10:00:00Z"), "pdf");
    assert.equal(name, "ilorin-estate-dinner-2026-2026-09-21.pdf");
    assert.ok(!/[\\/:*?"<>|]/.test(name));
  });

  it("does not produce a bare extension when everything was stripped", () => {
    assert.equal(reportFilename(["₦₦₦"], new Date("2026-09-21T10:00:00Z"), "csv"), "2026-09-21.csv");
  });
});
