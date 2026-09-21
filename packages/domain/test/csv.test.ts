import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { csvField, csvFilename, toCsv } from "../src/csv.ts";

describe("csvField", () => {
  it("leaves an ordinary value alone", () => {
    assert.equal(csvField("Ada Obi"), "Ada Obi");
    assert.equal(csvField(2), "2");
  });

  it("writes nothing for null and undefined, not the word", () => {
    assert.equal(csvField(null), "");
    assert.equal(csvField(undefined), "");
  });

  it("quotes a value containing a comma, so it stays one column", () => {
    assert.equal(csvField("Obi, Ada"), '"Obi, Ada"');
  });

  it("doubles quotes inside a quoted value", () => {
    assert.equal(csvField('Ada "Blue" Obi'), '"Ada ""Blue"" Obi"');
  });

  it("quotes a value containing a line break", () => {
    assert.equal(csvField("12 Bode Thomas\nSurulere"), '"12 Bode Thomas\nSurulere"');
  });

  it("defuses a value a spreadsheet would run as a formula (CSV injection)", () => {
    // Excel executes a cell starting with = + - @. An exported member note is
    // exactly the place someone would put one.
    assert.equal(csvField("=1+1"), "'=1+1");
    assert.equal(csvField("+2348011112222"), "'+2348011112222");
    assert.equal(csvField("@SUM(A1:A2)"), "'@SUM(A1:A2)");
    assert.equal(csvField("-5"), "'-5");
  });
});

describe("toCsv", () => {
  interface Row {
    name: string;
    amount: number;
  }
  const columns = [
    { header: "Full Name", value: (row: Row) => row.name },
    { header: "Amount", value: (row: Row) => row.amount },
  ];

  it("writes a header row and CRLF line endings, with a BOM Excel can read", () => {
    const csv = toCsv(columns, [{ name: "Ada Obi", amount: 5000 }]);
    assert.equal(csv, "﻿Full Name,Amount\r\nAda Obi,5000\r\n");
  });

  it("writes headers even when there are no rows at all", () => {
    assert.equal(toCsv(columns, []), "﻿Full Name,Amount\r\n");
  });

  it("keeps a row's columns aligned when a value contains a comma", () => {
    const csv = toCsv(columns, [{ name: "Obi, Ada", amount: 1 }]);
    assert.equal(csv, '﻿Full Name,Amount\r\n"Obi, Ada",1\r\n');
  });
});

describe("csvFilename", () => {
  it("builds a name that is safe on Windows", () => {
    const name = csvFilename(["KWASU Microbiology", "Annual Dinner 2026"], new Date("2026-09-21T10:00:00Z"));
    assert.equal(name, "kwasu-microbiology-annual-dinner-2026-2026-09-21.csv");
    assert.ok(!/[\/:*?"<>|]/.test(name));
  });

  it("never produces a bare extension when every part is punctuation", () => {
    assert.equal(csvFilename(["///"], new Date("2026-09-21T10:00:00Z")), "2026-09-21.csv");
  });
});
