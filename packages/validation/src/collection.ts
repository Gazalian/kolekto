/**
 * collection.ts — validation for the forms in front of the collection write
 * functions (20260919120000_collection_and_obligation_functions.sql).
 *
 * Same standing as community.ts: these mirror the database's own constraints so
 * a form can refuse bad input without a round trip. They are not the
 * authorization or integrity boundary — every rule here is checked again by the
 * function that performs the write, and several of them exist in three places
 * on purpose (form, function, table constraint).
 *
 * MONEY IS NOT CONVERTED HERE. An amount arrives as the text a person typed
 * ("20,000", "₦5000", "20k") and leaves as the same text, validated. Turning it
 * into kobo is `@kolekto/domain`'s `fromNaira`, which is the only place in the
 * codebase where a monetary value is parsed (ADR 0003). A schema that quietly
 * produced a number would be a second one.
 */

import { z } from "zod";

export const COLLECTION_CATEGORIES = ["dues", "contribution", "event", "fundraiser", "items", "other"] as const;
export const PARTICIPATION_MODES = ["open", "managed"] as const;
export const AMOUNT_MODELS = ["fixed", "open_amount", "tiers", "per_member", "items"] as const;
export const RECURRENCE_FREQUENCIES = ["weekly", "monthly", "quarterly", "yearly"] as const;
export const PAYMENT_PLANS = ["full_only", "installments_allowed"] as const;
export const COLLECTION_SCHEDULES = ["one_time", "recurring"] as const;
export const COLLECTION_VISIBILITIES = ["public", "unlisted", "members_only"] as const;
export const COLLECTION_STATUSES = [
  "draft",
  "scheduled",
  "active",
  "paused",
  "closed",
  "suspended",
  "archived",
] as const;
export const COLLECTION_FIELD_TYPES = ["text", "number", "single_select", "date"] as const;
export const COLLECTION_AUDIENCE_MODES = ["all_members", "groups", "selected_members", "public"] as const;

export type CollectionCategory = (typeof COLLECTION_CATEGORIES)[number];
export type ParticipationMode = (typeof PARTICIPATION_MODES)[number];
export type AmountModel = (typeof AMOUNT_MODELS)[number];
export type PaymentPlan = (typeof PAYMENT_PLANS)[number];
export type CollectionSchedule = (typeof COLLECTION_SCHEDULES)[number];
export type CollectionVisibility = (typeof COLLECTION_VISIBILITIES)[number];
export type CollectionStatus = (typeof COLLECTION_STATUSES)[number];
export type CollectionFieldType = (typeof COLLECTION_FIELD_TYPES)[number];
export type CollectionAudienceMode = (typeof COLLECTION_AUDIENCE_MODES)[number];
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

/**
 * The shapes `fromNaira` accepts, minus the negatives it would also parse: an
 * amount someone is asked to pay is never below zero, and "-5000" in a price
 * field is a typo, not an instruction.
 */
const NAIRA_PATTERN = /^₦?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?k?$/i;

export const nairaAmountSchema = z
  .string()
  .trim()
  .min(1, "Enter an amount")
  .max(20, "That amount is too long")
  .regex(NAIRA_PATTERN, "Enter an amount like 5000, 5,000 or 5k")
  .refine((value) => !/^₦?\s*0+(\.0{1,2})?k?$/i.test(value), "The amount must be above zero");

export const optionalNairaAmountSchema = z
  .union([nairaAmountSchema, z.literal("")])
  .optional()
  .transform((value) => (value === "" ? undefined : value));

/** A `datetime-local` value or an ISO string, kept as text and checked for being a real instant. */
export const dateTimeSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), "Enter a valid date and time");

export const optionalDateTimeSchema = z
  .union([dateTimeSchema, z.literal("")])
  .optional()
  .transform((value) => (value === "" ? undefined : value));

export const collectionNameSchema = z
  .string()
  .trim()
  .min(3, "Name must be at least 3 characters")
  .max(80, "Name must be at most 80 characters");

export const collectionDescriptionSchema = z
  .string()
  .trim()
  .max(2000, "Description must be at most 2000 characters")
  .optional();

const collectionConfigShape = {
  name: collectionNameSchema,
  description: collectionDescriptionSchema,
  category: z.enum(COLLECTION_CATEGORIES),
  participationMode: z.enum(PARTICIPATION_MODES),
  amountModel: z.enum(AMOUNT_MODELS),
  paymentPlan: z.enum(PAYMENT_PLANS).default("full_only"),
  schedule: z.enum(COLLECTION_SCHEDULES).default("one_time"),
  fixedAmount: optionalNairaAmountSchema,
  minAmount: optionalNairaAmountSchema,
  maxAmount: optionalNairaAmountSchema,
  targetAmount: optionalNairaAmountSchema,
  startsAt: optionalDateTimeSchema,
  deadlineAt: optionalDateTimeSchema,
  visibility: z.enum(COLLECTION_VISIBILITIES).default("unlisted"),
  allowNonMembers: z.boolean().default(false),
  allowAnonymous: z.boolean().default(false),
  thankYouMessage: z.string().trim().max(500).optional(),
};

/**
 * The cross-field rules, in one place so create and update cannot drift apart.
 * Each one restates a CHECK constraint on `public.collections`; the wording is
 * what an organiser should read, and the constraint is what actually holds.
 */
function checkCollectionConfig(
  value: {
    amountModel: AmountModel;
    participationMode: ParticipationMode;
    paymentPlan: PaymentPlan;
    schedule?: CollectionSchedule;
    fixedAmount?: string | undefined;
    minAmount?: string | undefined;
    maxAmount?: string | undefined;
    startsAt?: string | undefined;
    deadlineAt?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  // Deliberately NOT "a fixed collection must have an amount". A draft is the
  // unfinished state, and M7.5 saves each wizard step as it is completed —
  // which means a fixed collection exists as a row before the amount has been
  // typed (20260921160000). The rule that matters is enforced where a
  // contributor could actually be affected by it:
  // `app.transition_collection_status` refuses to publish a fixed collection
  // with no amount. Repeating it here would only block saving the draft.
  if (value.amountModel !== "fixed" && value.fixedAmount) {
    ctx.addIssue({ code: "custom", path: ["fixedAmount"], message: "Only a fixed collection has a single amount" });
  }
  if (value.amountModel !== "fixed" && value.fixedAmount) {
    ctx.addIssue({ code: "custom", path: ["fixedAmount"], message: "Only a fixed collection has a single amount" });
  }
  if (value.amountModel !== "open_amount" && (value.minAmount || value.maxAmount)) {
    ctx.addIssue({
      code: "custom",
      path: ["minAmount"],
      message: "A range applies only when contributors choose their own amount",
    });
  }
  if (value.amountModel === "per_member" && value.participationMode !== "managed") {
    ctx.addIssue({
      code: "custom",
      path: ["participationMode"],
      message: "A per-member amount needs a member list, so the collection must be managed",
    });
  }
  if (value.schedule === "recurring" && value.participationMode !== "managed") {
    ctx.addIssue({
      code: "custom",
      path: ["participationMode"],
      message: "A recurring collection needs a member list, so it must be managed",
    });
  }
  if (value.amountModel === "open_amount" && value.paymentPlan === "installments_allowed") {
    ctx.addIssue({
      code: "custom",
      path: ["paymentPlan"],
      message: "Every open contribution is already complete, so installments do not apply",
    });
  }
  if (value.paymentPlan === "installments_allowed" && !value.deadlineAt) {
    ctx.addIssue({
      code: "custom",
      path: ["deadlineAt"],
      message: "A collection that allows installments needs a deadline",
    });
  }
  if (value.startsAt && value.deadlineAt && Date.parse(value.deadlineAt) <= Date.parse(value.startsAt)) {
    ctx.addIssue({ code: "custom", path: ["deadlineAt"], message: "The deadline must be after the start date" });
  }
}

export const createCollectionSchema = z
  .object({ communityId: z.string().uuid(), ...collectionConfigShape })
  .superRefine(checkCollectionConfig);

export type CreateCollectionInput = z.infer<typeof createCollectionSchema>;

export const updateCollectionSchema = z
  .object({ collectionId: z.string().uuid(), ...collectionConfigShape })
  .superRefine(checkCollectionConfig);

export type UpdateCollectionInput = z.infer<typeof updateCollectionSchema>;

// ── Tiers (ADR 0010) ────────────────────────────────────────────────────────

export const tierSchema = z.object({
  /** Present when editing an existing option. Its identity, not its name. */
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1, "Every option needs a name").max(60, "Option names are at most 60 characters"),
  description: z.string().trim().max(500).optional(),
  price: nairaAmountSchema,
  quantityLimit: z.number().int().positive().optional(),
  perOrderLimit: z.number().int().positive().optional(),
  codePrefix: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{1,8}$/, "A code prefix is up to 8 letters or digits")
    .optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});

export type TierInput = z.infer<typeof tierSchema>;

export const setCollectionTiersSchema = z.object({
  collectionId: z.string().uuid(),
  tiers: z
    .array(tierSchema)
    .min(1, "A collection with options needs at least one")
    .max(50, "A collection can offer at most 50 options")
    // The rule the 2026-08-06 incident came from. Checked here so the organiser
    // is told which name collides; checked again by the function, and held by
    // collection_tiers_unique_name whatever either of them does.
    .refine(
      (tiers) => new Set(tiers.map((tier) => tier.name.trim().toLowerCase())).size === tiers.length,
      "Two options share the same name — give each one a distinct name",
    ),
});

export type SetCollectionTiersInput = z.infer<typeof setCollectionTiersSchema>;

// ── Custom questions (PRD 4.3) ──────────────────────────────────────────────

export const collectionFieldSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{0,38}$/, "Use lowercase letters, numbers and underscores, starting with a letter"),
  label: z.string().trim().min(1, "Every question needs a label").max(80),
  type: z.enum(COLLECTION_FIELD_TYPES),
  options: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  required: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});

export type CollectionFieldInput = z.infer<typeof collectionFieldSchema>;

export const setCollectionFieldsSchema = z.object({
  collectionId: z.string().uuid(),
  fields: z
    .array(collectionFieldSchema)
    .max(10, "A collection can ask at most 10 questions")
    .refine(
      (fields) => new Set(fields.map((field) => field.key)).size === fields.length,
      "Two questions share the same key",
    )
    .refine(
      (fields) => fields.every((field) => field.type !== "single_select" || (field.options?.length ?? 0) > 0),
      "A choice question needs at least one option",
    ),
});

export type SetCollectionFieldsInput = z.infer<typeof setCollectionFieldsSchema>;

// ── Lifecycle (STM-01) ──────────────────────────────────────────────────────

export const transitionCollectionStatusSchema = z.object({
  collectionId: z.string().uuid(),
  /** The status the caller believes the collection is in. Compare-and-set. */
  expected: z.enum(COLLECTION_STATUSES),
  target: z.enum(COLLECTION_STATUSES),
  reason: z.string().trim().max(500).optional(),
});

export type TransitionCollectionStatusInput = z.infer<typeof transitionCollectionStatusSchema>;

// ── Obligations ─────────────────────────────────────────────────────────────

export const assignObligationsSchema = z.object({
  collectionId: z.string().uuid(),
  memberIds: z
    .array(z.string().uuid())
    .min(1, "Select at least one member")
    .max(500, "Assign at most 500 members at a time"),
  /** Read only for a per-member collection; everywhere else the collection decides. */
  expectedAmount: optionalNairaAmountSchema,
  dueAt: optionalDateTimeSchema,
  /** Which period these obligations are for. Required on a recurring collection, refused on any other. */
  cycleKey: z
    .string()
    .trim()
    .regex(/^[0-9A-Za-z-]{4,20}$/)
    .optional(),
});

export type AssignObligationsInput = z.infer<typeof assignObligationsSchema>;

export const updateObligationAmountSchema = z.object({
  obligationId: z.string().uuid(),
  expectedAmount: nairaAmountSchema,
});

export const cancelObligationSchema = z.object({
  obligationId: z.string().uuid(),
  reason: z.string().trim().max(500).optional(),
});

export const exemptObligationSchema = z.object({
  obligationId: z.string().uuid(),
  reason: z.string().trim().min(3, "Give a reason — members and officers can see it").max(500),
});

export const waiveObligationSchema = z.object({
  obligationId: z.string().uuid(),
  waivedAmount: nairaAmountSchema,
  reason: z.string().trim().min(3, "Give a reason — members and officers can see it").max(500),
});

export type WaiveObligationInput = z.infer<typeof waiveObligationSchema>;

// ── Audience (§12, §37) ─────────────────────────────────────────────────────

/**
 * Who a collection is for.
 *
 * `groups` needs at least one group — an audience of no groups is nobody, which
 * is never what someone meant. The other three carry no group list: "everyone",
 * "these named people" and "anyone with the link" are complete on their own.
 */
export const setCollectionAudienceSchema = z
  .object({
    collectionId: z.string().uuid(),
    audienceMode: z.enum(COLLECTION_AUDIENCE_MODES),
    groupIds: z.array(z.string().uuid()).max(100).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.audienceMode === "groups" && value.groupIds.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["groupIds"],
        message: "Choose at least one group, or make the collection for all members",
      });
    }
  });

export type SetCollectionAudienceInput = z.infer<typeof setCollectionAudienceSchema>;

/** Materialising obligations from the audience. The amount is read only for a per-member collection; elsewhere the collection states it. */
export const syncObligationsSchema = z.object({
  collectionId: z.string().uuid(),
  expectedAmount: optionalNairaAmountSchema,
  dueAt: optionalDateTimeSchema,
  /** Which period these obligations belong to. Required for a recurring collection, refused for any other. */
  cycleKey: z
    .string()
    .trim()
    .regex(/^[0-9A-Za-z-]{4,20}$/)
    .optional(),
});

// ── Items (§31) ─────────────────────────────────────────────────────────────

export const collectionItemSchema = z.object({
  /** Present when editing an existing item. Its identity, not its name. */
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1, "Every item needs a name").max(80, "Item names are at most 80 characters"),
  description: z.string().trim().max(500).optional(),
  price: nairaAmountSchema,
  /** How many exist to sell. Absent means unlimited, which is not the same as zero. */
  quantityAvailable: z.number().int().min(0).max(1_000_000).optional(),
  maxPerOrder: z.number().int().positive().max(1000).optional(),
  /** Set only by the upload action, which returns a URL already scoped to this collection — never typed in by hand. */
  imageUrl: z.string().trim().url().max(500).optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});

export type CollectionItemInput = z.infer<typeof collectionItemSchema>;

export const setCollectionItemsSchema = z.object({
  collectionId: z.string().uuid(),
  items: z
    .array(collectionItemSchema)
    .min(1, "An item collection needs at least one item")
    .max(50, "A collection can offer at most 50 items")
    // The same rule as tiers, for the same reason: two items with one name
    // cannot be told apart on an order or a receipt.
    .refine(
      (items) => new Set(items.map((item) => item.name.trim().toLowerCase())).size === items.length,
      "Two items share the same name — give each one a distinct name",
    ),
});

export type SetCollectionItemsInput = z.infer<typeof setCollectionItemsSchema>;

// ── The event a ticketed collection is for (§30) ────────────────────────────

/**
 * Distinct from the collection's own dates on purpose: `startsAt`/`deadlineAt`
 * say when tickets are on sale, and these say when the dinner is.
 */
export const setCollectionEventSchema = z
  .object({
    collectionId: z.string().uuid(),
    eventStartsAt: optionalDateTimeSchema,
    eventEndsAt: optionalDateTimeSchema,
    venue: z.string().trim().max(200, "A venue is at most 200 characters").optional(),
    /** §18: ask the public form for one name per ticket unit ordered, not only the buyer's. */
    collectAttendeeDetails: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.eventEndsAt && !value.eventStartsAt) {
      ctx.addIssue({ code: "custom", path: ["eventStartsAt"], message: "Set when the event starts" });
    }
    if (
      value.eventStartsAt &&
      value.eventEndsAt &&
      Date.parse(value.eventEndsAt) < Date.parse(value.eventStartsAt)
    ) {
      ctx.addIssue({ code: "custom", path: ["eventEndsAt"], message: "The event cannot end before it starts" });
    }
  });

export type SetCollectionEventInput = z.infer<typeof setCollectionEventSchema>;

// ── Suggested amounts (§26, §29) ────────────────────────────────────────────

export const setCollectionSuggestedAmountsSchema = z.object({
  collectionId: z.string().uuid(),
  /** Text, like every other amount here — `fromNaira` is the only converter (ADR 0003). */
  amounts: z.array(nairaAmountSchema).max(6, "Offer at most 6 suggested amounts"),
});

export type SetCollectionSuggestedAmountsInput = z.infer<typeof setCollectionSuggestedAmountsSchema>;

// ── Recurrence (§32) ────────────────────────────────────────────────────────

export const setCollectionRecurrenceSchema = z.object({
  collectionId: z.string().uuid(),
  frequency: z.enum(RECURRENCE_FREQUENCIES),
  /** Every 1 month, every 2 months. Separate from frequency so "quarterly" means one thing everywhere. */
  intervalCount: z.number().int().min(1).max(12).default(1),
  startsOn: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date like 2026-10-01")
    .optional(),
  /** How long after a period opens its obligations are due. */
  dueAfterDays: z.number().int().min(0).max(180).default(0),
});

export type SetCollectionRecurrenceInput = z.infer<typeof setCollectionRecurrenceSchema>;

// ── A fundraiser's story (§5, §19) ─────────────────────────────────────────

const storyPartSchema = z.string().trim().max(2000, "Keep each part to 2000 characters or fewer").optional();

export const setCollectionStorySchema = z.object({
  collectionId: z.string().uuid(),
  storyWhat: storyPartSchema,
  storyWhy: storyPartSchema,
  storyImpact: storyPartSchema,
});

export type SetCollectionStoryInput = z.infer<typeof setCollectionStorySchema>;
