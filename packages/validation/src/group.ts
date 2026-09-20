/**
 * group.ts — validation for the member group write functions
 * (20260920130000_member_groups.sql).
 *
 * Groups are not mutually exclusive anywhere in this model: a person is Youth
 * and Choir, a flat is Block B and Tenanted. Nothing here treats membership as
 * a single value, and `setMemberGroupsSchema` takes the whole set rather than
 * one id.
 */

import { z } from "zod";

export const groupNameSchema = z
  .string()
  .trim()
  .min(1, "Give the group a name")
  .max(60, "A group name is at most 60 characters");

export const createGroupSchema = z.object({
  communityId: z.string().uuid(),
  name: groupNameSchema,
  description: z.string().trim().max(500).optional(),
  /** MEM-04: may someone joining through an invite link put themselves in this group? */
  pickableAtJoin: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});

export type CreateGroupInput = z.infer<typeof createGroupSchema>;

export const updateGroupSchema = z.object({
  groupId: z.string().uuid(),
  name: groupNameSchema,
  description: z.string().trim().max(500).optional(),
  pickableAtJoin: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});

export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;

export const archiveGroupSchema = z.object({
  groupId: z.string().uuid(),
  archived: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

export const addMembersToGroupSchema = z.object({
  groupId: z.string().uuid(),
  memberIds: z
    .array(z.string().uuid())
    .min(1, "Select at least one member")
    .max(500, "Add at most 500 members at a time"),
});

export const removeMemberFromGroupSchema = z.object({
  groupId: z.string().uuid(),
  memberId: z.string().uuid(),
});

export const setMemberGroupsSchema = z.object({
  memberId: z.string().uuid(),
  /** The complete set. An empty array means "in no groups", which is a valid answer. */
  groupIds: z.array(z.string().uuid()).max(100),
});

export type SetMemberGroupsInput = z.infer<typeof setMemberGroupsSchema>;
