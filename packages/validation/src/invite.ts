/**
 * invite.ts — validation for both invitation kinds (section 19):
 *   · member invite links (MEM-05) — app.create_invite_link, app.redeem_invite_link
 *   · officer invitations (OFF-01) — app.create_officer_invitation
 */

import { z } from "zod";
import { memberNameSchema, memberPhoneSchema } from "./member.ts";

export const createInviteLinkSchema = z.object({
  communityId: z.string().uuid(),
  groupIds: z.array(z.string().uuid()).default([]),
  allowGroupChoice: z.boolean().default(false),
  allowMultiGroup: z.boolean().default(false),
  approveJoiners: z.boolean().default(false),
  expiresAt: z.string().datetime().optional(),
  maxUses: z.number().int().positive().optional(),
  label: z.string().trim().max(60).optional(),
});

export type CreateInviteLinkInput = z.infer<typeof createInviteLinkSchema>;

export const redeemInviteLinkSchema = z.object({
  token: z.string().trim().min(1, "Invite link is missing its token"),
  fullName: memberNameSchema,
  phoneE164: memberPhoneSchema,
  email: z.string().trim().email().optional(),
  groupIds: z.array(z.string().uuid()).default([]),
});

export type RedeemInviteLinkInput = z.infer<typeof redeemInviteLinkSchema>;

export const OFFICER_ROLES = ["owner", "admin", "treasurer", "collector", "viewer"] as const;
export type OfficerRole = (typeof OFFICER_ROLES)[number];

export const createOfficerInvitationSchema = z
  .object({
    communityId: z.string().uuid(),
    role: z.enum(OFFICER_ROLES),
    title: z.string().trim().min(2).max(60).optional(),
    inviteeName: z.string().trim().max(120).optional(),
    inviteePhoneE164: memberPhoneSchema.optional(),
    inviteeEmail: z.string().trim().email().optional(),
  })
  .refine((v) => v.inviteePhoneE164 || v.inviteeEmail, {
    message: "An officer invitation needs a phone number or an email address",
    path: ["inviteeEmail"],
  });

export type CreateOfficerInvitationInput = z.infer<typeof createOfficerInvitationSchema>;

export const invitationTokenSchema = z.object({
  token: z.string().trim().min(1, "Missing invitation token"),
});
