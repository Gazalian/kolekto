import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assignObligationsSchema,
  collectionItemSchema,
  createCollectionSchema,
  exemptObligationSchema,
  nairaAmountSchema,
  setCollectionEventSchema,
  setCollectionFieldsSchema,
  setCollectionStorySchema,
  setCollectionTiersSchema,
  transitionCollectionStatusSchema,
  publishCollectionSchema,
  waiveObligationSchema,
  announceCollectionUpdateSchema,
  sendCollectionPublishReminderSchema,
} from "../src/collection.ts";

const COMMUNITY_ID = "01930000-0000-7000-8000-00000000000a";
const COLLECTION_ID = "01930000-0000-7000-8000-00000000000c";

function fixedCollection(overrides: Record<string, unknown> = {}) {
  return {
    communityId: COMMUNITY_ID,
    name: "Departmental Dues 2026",
    category: "dues",
    participationMode: "managed",
    amountModel: "fixed",
    fixedAmount: "5000",
    ...overrides,
  };
}

describe("nairaAmountSchema", () => {
  it("accepts the shapes a Nigerian user types (UX-07)", () => {
    for (const input of ["5000", "5,000", "₦5,000", "5000.50", "20k"]) {
      assert.equal(nairaAmountSchema.safeParse(input).success, true, input);
    }
  });

  it("rejects zero, negatives and anything that is not an amount", () => {
    for (const input of ["0", "0.00", "-5000", "five thousand", "5000.999", ""]) {
      assert.equal(nairaAmountSchema.safeParse(input).success, false, input);
    }
  });
});

describe("createCollectionSchema", () => {
  it("accepts a fixed managed collection with an amount", () => {
    assert.equal(createCollectionSchema.safeParse(fixedCollection()).success, true);
  });

  it("accepts a fixed collection with no amount yet — a draft is allowed to be unfinished", () => {
    // M7.5 saves each wizard step as it completes, so the row exists before
    // the amount is typed (20260921160000). What stops a priceless collection
    // reaching a contributor is the publish gate in
    // app.transition_collection_status, not this schema.
    const result = createCollectionSchema.safeParse(fixedCollection({ fixedAmount: undefined }));
    assert.equal(result.success, true);
  });

  it("refuses a single amount on a collection that is not fixed", () => {
    const result = createCollectionSchema.safeParse(
      fixedCollection({ amountModel: "open_amount", fixedAmount: "5000" }),
    );
    assert.equal(result.success, false);
  });

  it("refuses a range on anything but an open-amount collection", () => {
    const result = createCollectionSchema.safeParse(
      fixedCollection({ amountModel: "tiers", fixedAmount: undefined, minAmount: "1000" }),
    );
    assert.equal(result.success, false);
  });

  it("refuses a per-member amount on an open collection — there is no member list", () => {
    const result = createCollectionSchema.safeParse(
      fixedCollection({ amountModel: "per_member", fixedAmount: undefined, participationMode: "open" }),
    );
    assert.equal(result.success, false);
  });

  it("refuses installments without a deadline (COL-03)", () => {
    const result = createCollectionSchema.safeParse(fixedCollection({ paymentPlan: "installments_allowed" }));
    assert.equal(result.success, false);
  });

  it("refuses installments on an open-amount collection — each contribution is already complete", () => {
    const result = createCollectionSchema.safeParse(
      fixedCollection({
        amountModel: "open_amount",
        fixedAmount: undefined,
        paymentPlan: "installments_allowed",
        deadlineAt: "2026-12-31T23:59",
      }),
    );
    assert.equal(result.success, false);
  });

  it("refuses a deadline before the start date", () => {
    const result = createCollectionSchema.safeParse(
      fixedCollection({ startsAt: "2026-12-01T09:00", deadlineAt: "2026-11-01T09:00" }),
    );
    assert.equal(result.success, false);
  });

  it("defaults the fields an organiser should not have to think about", () => {
    const parsed = createCollectionSchema.parse(fixedCollection());
    assert.equal(parsed.paymentPlan, "full_only");
    assert.equal(parsed.schedule, "one_time");
    assert.equal(parsed.visibility, "unlisted");
    assert.equal(parsed.allowAnonymous, false);
  });
});

describe("setCollectionTiersSchema", () => {
  it("accepts options with distinct names", () => {
    const result = setCollectionTiersSchema.safeParse({
      collectionId: COLLECTION_ID,
      tiers: [
        { name: "Standard", price: "5,000" },
        { name: "VIP", price: "20000" },
      ],
    });
    assert.equal(result.success, true);
  });

  it("refuses two options with the same name, ignoring case (ADR 0010)", () => {
    const result = setCollectionTiersSchema.safeParse({
      collectionId: COLLECTION_ID,
      tiers: [
        { name: "Standard", price: "5000" },
        { name: "standard", price: "9000" },
      ],
    });
    assert.equal(result.success, false);
  });

  it("refuses an empty list and a free option", () => {
    assert.equal(setCollectionTiersSchema.safeParse({ collectionId: COLLECTION_ID, tiers: [] }).success, false);
    assert.equal(
      setCollectionTiersSchema.safeParse({ collectionId: COLLECTION_ID, tiers: [{ name: "Free", price: "0" }] })
        .success,
      false,
    );
  });
});

describe("setCollectionFieldsSchema", () => {
  it("accepts up to ten questions", () => {
    const fields = Array.from({ length: 10 }, (_, index) => ({
      key: `question_${index}`,
      label: `Question ${index}`,
      type: "text" as const,
    }));
    assert.equal(setCollectionFieldsSchema.safeParse({ collectionId: COLLECTION_ID, fields }).success, true);
  });

  it("refuses an eleventh question (PRD 4.3)", () => {
    const fields = Array.from({ length: 11 }, (_, index) => ({
      key: `question_${index}`,
      label: `Question ${index}`,
      type: "text" as const,
    }));
    assert.equal(setCollectionFieldsSchema.safeParse({ collectionId: COLLECTION_ID, fields }).success, false);
  });

  it("refuses a key that is not a safe identifier, and a choice with no options", () => {
    assert.equal(
      setCollectionFieldsSchema.safeParse({
        collectionId: COLLECTION_ID,
        fields: [{ key: "Matric Number", label: "Matric number", type: "text" }],
      }).success,
      false,
    );
    assert.equal(
      setCollectionFieldsSchema.safeParse({
        collectionId: COLLECTION_ID,
        fields: [{ key: "level", label: "Level", type: "single_select" }],
      }).success,
      false,
    );
  });
});

describe("lifecycle and obligations", () => {
  it("carries the status the caller believes the collection is in (compare-and-set)", () => {
    const result = transitionCollectionStatusSchema.safeParse({
      collectionId: COLLECTION_ID,
      expected: "draft",
      target: "active",
    });
    assert.equal(result.success, true);
  });

  it("the publish schema accepts all and none, and refuses unpaid (payment status cannot be established)", () => {
    assert.equal(
      publishCollectionSchema.safeParse({ collectionId: COLLECTION_ID, expected: "draft", notifyTarget: "unpaid" }).success,
      false,
      "unpaid targeting is disabled",
    );
    for (const notifyTarget of ["all", "none"] as const) {
      assert.equal(
        publishCollectionSchema.safeParse({
          collectionId: COLLECTION_ID,
          expected: "draft",
          notifyTarget,
        }).success,
        true,
        `notifyTarget=${notifyTarget} should be accepted`,
      );
    }
    // Non-draft `expected` is refused — the host-facing publish is narrow.
    assert.equal(
      publishCollectionSchema.safeParse({
        collectionId: COLLECTION_ID,
        expected: "active",
        notifyTarget: "all",
      }).success,
      false,
    );
    // notifyTarget is required; omitting it must not quietly default to anything.
    assert.equal(
      publishCollectionSchema.safeParse({
        collectionId: COLLECTION_ID,
        expected: "draft",
      }).success,
      false,
    );
    // An unknown target is refused — not a free-text string.
    assert.equal(
      publishCollectionSchema.safeParse({
        collectionId: COLLECTION_ID,
        expected: "draft",
        notifyTarget: "everyone",
      }).success,
      false,
    );
  });

  it("caps a bulk assignment at 500 members per call", () => {
    const memberIds = Array.from({ length: 501 }, () => crypto.randomUUID());
    assert.equal(assignObligationsSchema.safeParse({ collectionId: COLLECTION_ID, memberIds }).success, false);
    assert.equal(
      assignObligationsSchema.safeParse({ collectionId: COLLECTION_ID, memberIds: memberIds.slice(0, 500) }).success,
      true,
    );
  });

  it("requires a reason to exempt or waive — members and officers read it (OBL-07, OBL-08)", () => {
    const obligationId = crypto.randomUUID();
    assert.equal(exemptObligationSchema.safeParse({ obligationId, reason: "" }).success, false);
    assert.equal(exemptObligationSchema.safeParse({ obligationId, reason: "Graduated" }).success, true);
    assert.equal(
      waiveObligationSchema.safeParse({ obligationId, waivedAmount: "2000", reason: "" }).success,
      false,
    );
    assert.equal(
      waiveObligationSchema.safeParse({ obligationId, waivedAmount: "2000", reason: "Hardship" }).success,
      true,
    );
  });
});

describe("collectionItemSchema", () => {
  const base = { name: "Blue", price: "35000" };

  it("accepts an item with no image", () => {
    assert.equal(collectionItemSchema.safeParse(base).success, true);
  });

  it("accepts an item whose image is a URL — set only by the upload action, never typed", () => {
    assert.equal(
      collectionItemSchema.safeParse({ ...base, imageUrl: "https://x.test/storage/v1/object/public/collection-covers/a/b/items/1.png" })
        .success,
      true,
    );
  });

  it("refuses a value that is not a URL at all", () => {
    assert.equal(collectionItemSchema.safeParse({ ...base, imageUrl: "not a url" }).success, false);
  });
});

describe("setCollectionEventSchema", () => {
  const COLLECTION_ID_2 = "01930000-0000-7000-8000-00000000000d";

  it("defaults collectAttendeeDetails to false when not sent", () => {
    const result = setCollectionEventSchema.safeParse({ collectionId: COLLECTION_ID_2 });
    assert.equal(result.success, true);
    if (result.success) assert.equal(result.data.collectAttendeeDetails, false);
  });

  it("accepts an explicit true", () => {
    const result = setCollectionEventSchema.safeParse({
      collectionId: COLLECTION_ID_2,
      collectAttendeeDetails: true,
    });
    assert.equal(result.success, true);
    if (result.success) assert.equal(result.data.collectAttendeeDetails, true);
  });
});

describe("setCollectionStorySchema", () => {
  const COLLECTION_ID_3 = "01930000-0000-7000-8000-00000000000e";

  it("accepts all three parts, or none of them", () => {
    assert.equal(
      setCollectionStorySchema.safeParse({
        collectionId: COLLECTION_ID_3,
        storyWhat: "A library for 200 students",
        storyWhy: "They share 3 books today",
        storyImpact: "Buys 500 books",
      }).success,
      true,
    );
    assert.equal(setCollectionStorySchema.safeParse({ collectionId: COLLECTION_ID_3 }).success, true);
  });

  it("refuses a story section past 2000 characters", () => {
    assert.equal(
      setCollectionStorySchema.safeParse({ collectionId: COLLECTION_ID_3, storyWhat: "x".repeat(2001) }).success,
      false,
    );
    assert.equal(
      setCollectionStorySchema.safeParse({ collectionId: COLLECTION_ID_3, storyWhat: "x".repeat(2000) }).success,
      true,
    );
  });
});

describe("member announcements", () => {
  const COLLECTION = "01a0bf9c-cf1a-7955-97d9-fb6eb27f8923";
  const KEY = "8d6f1c2e-1a2b-4c3d-9e8f-001122334455";

  it("the reminder schema accepts all only — unpaid is refused", () => {
    assert.equal(sendCollectionPublishReminderSchema.safeParse({ collectionId: COLLECTION, notifyTarget: "all", idempotencyKey: KEY }).success, true);
    assert.equal(sendCollectionPublishReminderSchema.safeParse({ collectionId: COLLECTION, notifyTarget: "unpaid", idempotencyKey: KEY }).success, false);
  });

  it("an update announcement names at least one change from the fixed list, never free text", () => {
    assert.equal(announceCollectionUpdateSchema.safeParse({ collectionId: COLLECTION, changedFields: ["deadline"], idempotencyKey: KEY }).success, true);
    assert.equal(announceCollectionUpdateSchema.safeParse({ collectionId: COLLECTION, changedFields: [], idempotencyKey: KEY }).success, false);
    assert.equal(announceCollectionUpdateSchema.safeParse({ collectionId: COLLECTION, changedFields: ["the price went up"], idempotencyKey: KEY }).success, false);
    assert.equal(announceCollectionUpdateSchema.safeParse({ collectionId: COLLECTION, changedFields: ["deadline"], idempotencyKey: "short" }).success, false);
  });

  it("an update announcement may carry an optional custom message within 1000 chars", () => {
    assert.equal(
      announceCollectionUpdateSchema.safeParse({ collectionId: COLLECTION, changedFields: ["deadline"], idempotencyKey: KEY, customMessage: "Hi folks" }).success,
      true,
    );
    assert.equal(
      announceCollectionUpdateSchema.safeParse({ collectionId: COLLECTION, changedFields: ["deadline"], idempotencyKey: KEY, customMessage: "x".repeat(1001) }).success,
      false,
    );
  });

  it("targetAudience must be allow-listed, and groups requires at least one group id", () => {
    assert.equal(
      announceCollectionUpdateSchema.safeParse({ collectionId: COLLECTION, changedFields: ["deadline"], idempotencyKey: KEY, targetAudience: "all_members" }).success,
      true,
    );
    assert.equal(
      announceCollectionUpdateSchema.safeParse({ collectionId: COLLECTION, changedFields: ["deadline"], idempotencyKey: KEY, targetAudience: "unpaid" }).success,
      false,
      "unpaid is deliberately not a valid target",
    );
    assert.equal(
      announceCollectionUpdateSchema.safeParse({
        collectionId: COLLECTION,
        changedFields: ["deadline"],
        idempotencyKey: KEY,
        targetAudience: "groups",
        targetGroupIds: [],
      }).success,
      false,
      "groups target needs at least one group",
    );
    assert.equal(
      announceCollectionUpdateSchema.safeParse({
        collectionId: COLLECTION,
        changedFields: ["deadline"],
        idempotencyKey: KEY,
        targetAudience: "groups",
        targetGroupIds: [COLLECTION],
      }).success,
      true,
    );
  });
});
