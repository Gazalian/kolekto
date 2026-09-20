/**
 * member.ts — validation for the member write functions
 * (20260920120100_member_identity_functions.sql).
 *
 * The shape to notice: there is no `identifier` field. A community's
 * identifying attribute — matric number, house number, membership number — is
 * one of its own `member_attribute_definitions`, so it arrives inside
 * `attributes` keyed by that definition's key, exactly like every other
 * community field. Which one identifies a person is the community's decision;
 * this schema does not need to know which it is.
 *
 * Values are validated against their definitions server-side
 * (`app.set_member_attributes`): type, options and uniqueness are all things
 * only the database holds. These schemas check shape, not meaning.
 */

import { z } from "zod";

export const MEMBER_ATTRIBUTE_TYPES = ["text", "number", "single_select", "date"] as const;
export type MemberAttributeType = (typeof MEMBER_ATTRIBUTE_TYPES)[number];

/** A map of community field key to value. An empty string clears a field; an omitted key leaves it alone. */
const attributesSchema = z.record(z.string(), z.string()).default({});

export const memberNameSchema = z.string().trim().min(1, "Name is required").max(120);
export const memberPhoneSchema = z.string().trim().min(7).max(20);

export const createMemberSchema = z.object({
  communityId: z.string().uuid(),
  fullName: memberNameSchema,
  phoneE164: memberPhoneSchema.optional(),
  email: z.string().trim().email().optional(),
  attributes: attributesSchema,
  groupIds: z.array(z.string().uuid()).default([]),
  /** Set once the person has been shown a possible duplicate and chosen to continue. */
  confirmPossibleDuplicate: z.boolean().default(false),
});

export type CreateMemberInput = z.infer<typeof createMemberSchema>;

export const updateMemberSchema = z.object({
  memberId: z.string().uuid(),
  fullName: memberNameSchema,
  phoneE164: memberPhoneSchema.optional(),
  email: z.string().trim().email().optional(),
  attributes: attributesSchema,
});

export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

export const archiveMemberSchema = z.object({
  memberId: z.string().uuid(),
  reason: z.string().trim().max(500).optional(),
});

export type ArchiveMemberInput = z.infer<typeof archiveMemberSchema>;

export const restoreMemberSchema = archiveMemberSchema;

export const findMemberDuplicatesSchema = z.object({
  communityId: z.string().uuid(),
  fullName: z.string().trim().max(120).optional(),
  phoneE164: z.string().trim().max(20).optional(),
  email: z.string().trim().max(200).optional(),
  attributes: attributesSchema,
  excludeMemberId: z.string().uuid().optional(),
});

// ── Community member profile configuration ──────────────────────────────────

/** `KWASU/`, `EST/`, `MEM/`. Kept short and free of characters that would need escaping in a URL or a CSV. */
export const memberCodePrefixSchema = z
  .string()
  .trim()
  .max(16, "A prefix is at most 16 characters")
  .regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/, "Use letters, numbers and / _ . - only")
  .optional();

export const memberCodeSettingsSchema = z.object({
  communityId: z.string().uuid(),
  prefix: z.union([memberCodePrefixSchema, z.literal("")]).optional(),
  padding: z.number().int().min(1).max(12).default(4),
  /** A sequence may be moved forward, never back — a code already given out must never be reissued. */
  startingNumber: z.number().int().min(1).optional(),
});

export type MemberCodeSettingsInput = z.infer<typeof memberCodeSettingsSchema>;

export const memberFieldSchema = z
  .object({
    communityId: z.string().uuid(),
    definitionId: z.string().uuid().optional(),
    key: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{0,38}$/, "Use lowercase letters, numbers and underscores, starting with a letter"),
    label: z.string().trim().min(1, "Give the field a label").max(40),
    type: z.enum(MEMBER_ATTRIBUTE_TYPES),
    options: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
    requiredAtJoin: z.boolean().default(false),
    isUnique: z.boolean().default(false),
    isPrimaryIdentifier: z.boolean().default(false),
    sortOrder: z.number().int().min(0).max(1000).default(0),
  })
  .superRefine((value, ctx) => {
    if (value.type === "single_select" && (value.options?.length ?? 0) === 0) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "A choice field needs at least one option" });
    }
    if (value.isPrimaryIdentifier && !value.isUnique) {
      ctx.addIssue({
        code: "custom",
        path: ["isUnique"],
        message: "A primary identifier must be unique — it is what tells two members apart",
      });
    }
  });

export type MemberFieldInput = z.infer<typeof memberFieldSchema>;

/** Turns a comma-separated options box into the array the schema expects. */
export function parseFieldOptions(raw: string): string[] {
  return raw
    .split(",")
    .map((option) => option.trim())
    .filter((option) => option !== "");
}
