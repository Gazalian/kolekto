import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildContributorAnswersSchema,
  contributorContactSchema,
  type ContributorFieldDefinition,
} from "../src/contribution.ts";

describe("contributorContactSchema", () => {
  it("accepts a name, an email address and a phone number", () => {
    assert.equal(
      contributorContactSchema.safeParse({ fullName: "Chidi Eze", email: "chidi@example.test", phone: "+2348012345678" })
        .success,
      true,
    );
  });

  it("requires the email address — the receipt goes there and the payment provider needs one", () => {
    assert.equal(contributorContactSchema.safeParse({ fullName: "Chidi Eze", phone: "+2348012345678" }).success, false);
    assert.equal(
      contributorContactSchema.safeParse({ fullName: "Chidi Eze", email: "", phone: "+2348012345678" }).success,
      false,
    );
  });

  it("requires the phone number", () => {
    assert.equal(contributorContactSchema.safeParse({ fullName: "Chidi Eze", email: "chidi@example.test" }).success, false);
    assert.equal(
      contributorContactSchema.safeParse({ fullName: "Chidi Eze", email: "chidi@example.test", phone: "   " }).success,
      false,
    );
  });

  it("refuses a missing name, a malformed email and a too-short phone number", () => {
    const ok = { fullName: "Chidi", email: "chidi@example.test", phone: "+2348012345678" };
    assert.equal(contributorContactSchema.safeParse({ ...ok, fullName: "" }).success, false);
    assert.equal(contributorContactSchema.safeParse({ ...ok, email: "not-an-email" }).success, false);
    assert.equal(contributorContactSchema.safeParse({ ...ok, phone: "12345" }).success, false);
  });
});

describe("buildContributorAnswersSchema", () => {
  const fields: ContributorFieldDefinition[] = [
    { key: "matric_number", label: "Matric number", type: "text", options: null, required: true },
    { key: "level", label: "Level", type: "single_select", options: ["100", "200", "300"], required: true },
    { key: "shirt_size", label: "Shirt size", type: "text", options: null, required: false },
  ];

  it("requires the answers the collection marks as required", () => {
    const schema = buildContributorAnswersSchema(fields);
    assert.equal(schema.safeParse({ matric_number: "", level: "200" }).success, false);
    assert.equal(schema.safeParse({ matric_number: "CSC/2021/001", level: "200" }).success, true);
  });

  it("refuses an answer outside the offered choices", () => {
    const schema = buildContributorAnswersSchema(fields);
    const result = schema.safeParse({ matric_number: "CSC/2021/001", level: "900" });
    assert.equal(result.success, false);
  });

  it("drops an answer to a question this collection does not ask", () => {
    const schema = buildContributorAnswersSchema(fields);
    const parsed = schema.parse({
      matric_number: "CSC/2021/001",
      level: "300",
      injected_field: "anything at all",
    });
    assert.equal("injected_field" in parsed, false);
  });

  it("checks a number question is a number", () => {
    const schema = buildContributorAnswersSchema([
      { key: "quantity", label: "Quantity", type: "number", options: null, required: true },
    ]);
    assert.equal(schema.safeParse({ quantity: "two" }).success, false);
    assert.equal(schema.safeParse({ quantity: "2" }).success, true);
  });

  it("accepts an empty answer to an optional question", () => {
    const schema = buildContributorAnswersSchema([
      { key: "notes", label: "Notes", type: "text", options: null, required: false },
    ]);
    assert.equal(schema.safeParse({}).success, true);
    assert.equal(schema.safeParse({ notes: "" }).success, true);
  });
});
