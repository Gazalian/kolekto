/**
 * contribution.ts — validation for what a contributor fills in on a public
 * collection page.
 *
 * Two kinds of input, kept apart on purpose (PRD 4.3, and a known UX problem in
 * the previous system, which mixed them into one uncontrolled structure):
 *
 *   PAYMENT CONTACT     who is paying and how to reach them about it. Always
 *                        the same three fields, always meaning the same thing.
 *   COLLECTION QUESTIONS what this particular collection additionally needs —
 *                        a matric number, a shirt size, a unit number. Defined
 *                        per collection, so the schema for them is built from
 *                        the collection's own field definitions at request time.
 *
 * The amount is NOT validated here beyond being a readable figure. What a
 * selection is worth is decided by `@kolekto/domain`'s
 * `resolveContributionAmount`, against configuration loaded from the database —
 * a schema cannot know what a tier costs, and a schema that accepted the
 * browser's figure as authoritative would be the 2026-08-06 incident again.
 */

import { z } from "zod";
import { nairaAmountSchema, type CollectionFieldType } from "./collection.ts";

export const contributorContactSchema = z
  .object({
    fullName: z.string().trim().min(1, "Enter your name").max(120),
    email: z.union([z.string().trim().email("Enter a valid email address"), z.literal("")]).optional(),
    phone: z
      .union([z.string().trim().min(7, "Enter a valid phone number").max(20), z.literal("")])
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.email && !value.phone) {
      ctx.addIssue({
        code: "custom",
        path: ["email"],
        message: "Enter an email address or a phone number, so you can be sent a receipt",
      });
    }
  });

export type ContributorContact = z.infer<typeof contributorContactSchema>;

/** The selection part of the form. Both are optional here; which one is required depends on the collection, which the server resolves. */
export const contributionSelectionSchema = z.object({
  tierId: z.union([z.string().uuid(), z.literal("")]).optional(),
  amount: z.union([nairaAmountSchema, z.literal("")]).optional(),
});

export type ContributionSelectionInput = z.infer<typeof contributionSelectionSchema>;

export interface ContributorFieldDefinition {
  key: string;
  label: string;
  type: CollectionFieldType;
  options: string[] | null;
  required: boolean;
}

/**
 * Builds the schema for one collection's questions from its own definitions.
 *
 * Built per request from what the database returned, never from anything the
 * browser sent: a submitted answer to a question the collection does not ask is
 * dropped by `z.object`'s default stripping, and a required answer that is
 * missing fails here rather than being stored as an empty string.
 */
export function buildContributorAnswersSchema(
  fields: readonly ContributorFieldDefinition[],
): z.ZodType<Record<string, string>> {
  const shape: Record<string, z.ZodType<string>> = {};

  for (const field of fields) {
    let schema: z.ZodType<string>;

    switch (field.type) {
      case "number":
        schema = z
          .string()
          .trim()
          .regex(/^-?\d+(\.\d+)?$/, `${field.label} must be a number`);
        break;
      case "date":
        schema = z
          .string()
          .trim()
          .refine((value) => value === "" || !Number.isNaN(Date.parse(value)), `${field.label} must be a date`);
        break;
      case "single_select": {
        const options = field.options ?? [];
        schema = z
          .string()
          .trim()
          .refine((value) => value === "" || options.includes(value), `Choose one of the listed options for ${field.label}`);
        break;
      }
      case "text":
      default:
        schema = z.string().trim().max(500, `${field.label} is too long`);
        break;
    }

    shape[field.key] = field.required
      ? schema.refine((value) => value.trim().length > 0, `${field.label} is required`)
      : z.union([schema, z.literal("")]).optional().transform((value) => value ?? "");
  }

  return z.object(shape) as unknown as z.ZodType<Record<string, string>>;
}
