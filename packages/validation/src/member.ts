/**
 * member.ts — validation for app.create_member, app.update_member and
 * app.archive_member.
 */

import { z } from "zod";

const attributesSchema = z.record(z.string(), z.union([z.string(), z.number(), z.null()])).default({});

export const memberNameSchema = z.string().trim().min(1, "Name is required").max(120);
export const memberPhoneSchema = z.string().trim().min(7).max(20);
export const memberIdentifierSchema = z.string().trim().min(1).max(60).optional();

export const createMemberSchema = z.object({
  communityId: z.string().uuid(),
  fullName: memberNameSchema,
  phoneE164: memberPhoneSchema.optional(),
  email: z.string().trim().email().optional(),
  identifier: memberIdentifierSchema,
  attributes: attributesSchema,
  groupIds: z.array(z.string().uuid()).default([]),
});

export type CreateMemberInput = z.infer<typeof createMemberSchema>;

export const updateMemberSchema = z.object({
  memberId: z.string().uuid(),
  fullName: memberNameSchema,
  phoneE164: memberPhoneSchema.optional(),
  email: z.string().trim().email().optional(),
  identifier: memberIdentifierSchema,
  attributes: attributesSchema,
});

export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

export const archiveMemberSchema = z.object({
  memberId: z.string().uuid(),
  reason: z.string().trim().max(500).optional(),
});

export type ArchiveMemberInput = z.infer<typeof archiveMemberSchema>;
