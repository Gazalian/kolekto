/**
 * community.ts — validation for the forms in front of app.create_community and
 * app.update_community_profile (20260918140100_application_write_functions.sql).
 *
 * These mirror the database's own constraints (communities_name_length, the
 * community_type enum) so a form rejects bad input before a round trip, not
 * instead of the database checking again — the database is still the
 * authority (ADR 0008: every permission and every constraint is enforced on
 * the server, never only in a form).
 */

import { z } from "zod";

export const COMMUNITY_TYPES = [
  "university_association",
  "fellowship",
  "alumni_association",
  "cooperative",
  "estate",
  "professional_association",
  "event_committee",
  "social_group",
  "school_pta",
  "community_development",
  "other",
] as const;

export type CommunityType = (typeof COMMUNITY_TYPES)[number];

export const communityNameSchema = z
  .string()
  .trim()
  .min(3, "Name must be at least 3 characters")
  .max(80, "Name must be at most 80 characters");

export const createCommunitySchema = z.object({
  name: communityNameSchema,
  type: z.enum(COMMUNITY_TYPES),
  description: z.string().trim().max(500).optional(),
});

export type CreateCommunityInput = z.infer<typeof createCommunitySchema>;

export const updateCommunityProfileSchema = z.object({
  communityId: z.string().uuid(),
  name: communityNameSchema,
  description: z.string().trim().max(500).optional(),
  logoUrl: z.string().trim().url().optional(),
  locationState: z.string().trim().max(80).optional(),
  locationCity: z.string().trim().max(80).optional(),
  institution: z.string().trim().max(120).optional(),
  contactEmail: z.string().trim().email().optional(),
  contactPhoneE164: z.string().trim().min(7).max(20).optional(),
  showOfficersPublicly: z.boolean().default(false),
});

export type UpdateCommunityProfileInput = z.infer<typeof updateCommunityProfileSchema>;
