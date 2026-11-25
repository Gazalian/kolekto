import "server-only";

import { ConfigError, loadMembershipIdSecret } from "@kolekto/config";
import {
  type CallerContext,
  getMemberMembershipId,
  getMembershipIdSettings,
  isLegacyCheckUnavailable,
  isMembershipIdCollision,
  issueMembershipId,
  rotateMembershipId,
} from "@kolekto/db";
import { hashMembershipId, maskMembershipId, newMembershipId, type MembershipIdSeparator } from "./membership-id.ts";
import { createClient } from "./supabase/server.ts";

/**
 * Server side of membership IDs (owner decision A1: stored as plaintext).
 * Generates, retries on a collision, and reads the ID back for display. The
 * community is always derived from the member row the caller can see (RLS) —
 * never taken from the browser.
 *
 * The full ID is never logged here, and every error this module throws or
 * passes on comes from SQL functions that never echo it.
 */

const MAX_ATTEMPTS = 5;

export class MembershipIdUnavailable extends Error {}

async function memberCommunity(memberId: string): Promise<string> {
  const supabase = await createClient();
  const { data } = await supabase.from("members").select("community_id").eq("id", memberId).maybeSingle();
  if (!data) throw new MembershipIdUnavailable("That member could not be found.");
  return data.community_id as string;
}

/**
 * The legacy fingerprint of a candidate (owner decision D1), or null when the
 * server has no secret. The database requires it only in a community that
 * still holds fingerprint-only rows, and refuses to issue there without it.
 */
function legacyFingerprint(communityId: string, fullId: string): Buffer | null {
  let secret: string;
  try {
    secret = loadMembershipIdSecret();
  } catch (error) {
    if (error instanceof ConfigError) return null;
    throw error;
  }
  return hashMembershipId(secret, communityId, fullId);
}

/**
 * Issues (or replaces) a member's ID. Returns the full ID for the officer's
 * screen; it is stored as plaintext and can be shown again to authorised
 * officers (owner decisions A1, D5).
 */
export async function issueOrReplaceMembershipId(
  caller: CallerContext,
  memberId: string,
  mode: "issue" | "replace",
  reason: string | null = null,
): Promise<string> {
  const communityId = await memberCommunity(memberId);
  const settings = await getMembershipIdSettings(caller, communityId);
  if (!settings || !settings.enabled) {
    throw new MembershipIdUnavailable("Turn on membership IDs in community settings first.");
  }
  const format = {
    prefix: settings.prefix,
    separator: settings.separator as MembershipIdSeparator,
    suffixLength: settings.suffixLength,
  };

  for (let attempt = 1; ; attempt += 1) {
    const fullId = newMembershipId(format);
    const fingerprint = legacyFingerprint(communityId, fullId);
    try {
      if (mode === "issue") await issueMembershipId(caller, memberId, fullId, fingerprint);
      else await rotateMembershipId(caller, memberId, fullId, reason, fingerprint);
      return fullId;
    } catch (error) {
      if (isMembershipIdCollision(error) && attempt < MAX_ATTEMPTS) continue;
      if (isLegacyCheckUnavailable(error)) {
        throw new MembershipIdUnavailable("Membership IDs cannot be issued in this community until the server is fully configured.");
      }
      throw error;
    }
  }
}

export interface DisplayedMembershipId {
  /** The full ID: only for the owner and officers holding membership.issue_ids (D5); otherwise null. */
  fullId: string | null;
  masked: string;
  issuedAt: string;
}

/**
 * The member's current ID in full, or null if they have none or the caller
 * may not see it (owner decision D5: membership.issue_ids, checked in SQL).
 */
export async function displayMembershipId(caller: CallerContext, memberId: string): Promise<DisplayedMembershipId | null> {
  let stored;
  try {
    stored = await getMemberMembershipId(caller, memberId);
  } catch {
    return null;
  }
  if (!stored) return null;
  return {
    fullId: stored.membershipId,
    masked: maskMembershipId(stored.prefix, stored.separator, stored.last2),
    issuedAt: stored.issuedAt,
  };
}
