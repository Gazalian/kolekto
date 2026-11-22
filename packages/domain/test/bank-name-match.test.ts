import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { matchBankAccountName, nameTokens } from "../src/bank-name-match.ts";

describe("nameTokens", () => {
  it("normalises case, accents, punctuation, titles and initials", () => {
    assert.deepEqual(nameTokens("  Dr. Adaéze  N. O'kafor-Bello "), ["ADAEZE", "OKAFOR", "BELLO"]);
    assert.deepEqual(nameTokens("ALHAJI MUSA  ABUBAKAR JNR"), ["MUSA", "ABUBAKAR"]);
    assert.deepEqual(nameTokens(""), []);
    assert.deepEqual(nameTokens("Okafor Okafor"), ["OKAFOR"]);
  });
});

describe("matchBankAccountName (owner decision 2026-11-18, Q3)", () => {
  const cases: ReadonlyArray<[string, string, boolean, string]> = [
    ["Adaeze Okafor", "OKAFOR ADAEZE", true, "same names, bank order"],
    ["Adaeze Okafor", "OKAFOR ADAEZE NKECHI", true, "bank adds a middle name"],
    ["Adaeze Nkechi Okafor", "OKAFOR ADAEZE", true, "profile adds a middle name"],
    ["adaeze  okafor", "Okafor, Adaeze", true, "case, spacing and punctuation"],
    ["Mrs Adaeze Okafor", "OKAFOR ADAEZE", true, "title on the profile"],
    ["Adaeze N. Okafor", "ADAEZE OKAFOR", true, "initial on the profile"],
    ["Tunde Bello", "BELLO TUNDE ADEWALE", true, "three-name bank account"],
    ["Ada Okafor", "OKAFOR ADAEZE", false, "short form goes to review"],
    ["Adaeze", "ADAEZE OKAFOR", false, "a one-word profile name never auto-matches"],
    ["Adaeze Okafor", "JOHN DOE", false, "unrelated account"],
    ["Adaeze Okafor", "OKAFOR ENTERPRISES", false, "one shared name is not enough"],
    ["Adaeze Okafor Bello", "OKAFOR CHIDI BELLO", false, "two shared but each side has a different name"],
  ];
  for (const [profile, account, expected, why] of cases) {
    it(`${why}: "${profile}" vs "${account}" → ${expected}`, () => {
      assert.equal(matchBankAccountName(profile, account).matched, expected);
    });
  }

  it("says why", () => {
    assert.equal(matchBankAccountName("Adaeze", "ADAEZE OKAFOR").reason, "too_few_profile_names");
    assert.equal(matchBankAccountName("Adaeze Okafor", "JOHN DOE").reason, "names_differ");
    assert.equal(matchBankAccountName("Adaeze Okafor", "OKAFOR ADAEZE NKECHI").reason, "profile_names_on_account");
    assert.equal(matchBankAccountName("Adaeze Nkechi Okafor", "OKAFOR ADAEZE").reason, "account_names_on_profile");
  });
});
