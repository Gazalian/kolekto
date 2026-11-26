import "server-only";

import {
  confirmMembershipPass as dbConfirmPass,
  membershipPassSummary as dbPassSummary,
  validateMembershipId,
  type MembershipPassSummary,
} from "@kolekto/db";
import { loadMembershipIdSecret } from "@kolekto/config";
import { resolveCallerIdentity } from "./client-ip.ts";
import { hashClientAddress } from "./membership-id.ts";
import { clearMembershipPass, readMembershipPass, setMembershipPass } from "./membership-pass.ts";
import { setContributorSession } from "./contributor-session.ts";

export type { MembershipPassSummary };

export interface MembershipPassStart {
  valid: boolean;
  /** The caller's address could not be established from the trusted source; nothing was sent to the database. */
  unavailable?: true;
}

/**
 * Step 1: the contributor typed a membership ID.
 *
 * Validates against the database, which rate-limits and returns a 30-minute
 * access token on success. The token goes into the membership pass cookie;
 * the browser never sees it.
 *
 * The rate limit is keyed on the caller's address from the configured trusted
 * source only (`client-ip.ts`). When that cannot be established the attempt is
 * refused as "unavailable" BEFORE the database is called: no shared bucket, no
 * fallback to a header the caller can write.
 */
export async function startMembershipPass(
  collectionId: string,
  typedMembershipId: string,
): Promise<MembershipPassStart> {
  const caller = await resolveCallerIdentity();
  if (!caller.ok) return { valid: false, unavailable: true };
  const clientHash = hashClientAddress(loadMembershipIdSecret(), caller.identity);
  const result = await validateMembershipId(collectionId, typedMembershipId, clientHash);

  if (!result.valid || !result.accessToken) {
    return { valid: false };
  }

  await setMembershipPass(collectionId, result.accessToken);
  return { valid: true };
}

/**
 * Step 2: the confirmation screen loads.
 *
 * Reads the access token from the cookie and asks the database for the
 * member's masked details. Returns null when the cookie is missing, tampered,
 * expired, or the token no longer resolves.
 */
export async function loadMembershipPassSummary(
  collectionId: string,
): Promise<MembershipPassSummary | null> {
  const token = await readMembershipPass(collectionId);
  if (!token) return null;
  return dbPassSummary(collectionId, token);
}

/**
 * Step 3: "Yes, that is me."
 *
 * Re-checks the pass live (the SQL function does the eligibility check),
 * writes the masked audit row, then sets the contributor-session cookie so
 * the payment form knows which member this is. The membership pass cookie is
 * KEPT (M10): checkout sends its token to app.create_payment_attempt, which
 * re-resolves the pass and requires it to name the same member as the
 * session. It ends with its own 30 minutes, "not me", or a refused checkout.
 *
 * Returns the member UUID for server-side use, or null when the pass is no
 * longer valid.
 */
export async function completeMembershipPass(
  collectionId: string,
): Promise<string | null> {
  const token = await readMembershipPass(collectionId);
  if (!token) return null;

  const memberId = await dbConfirmPass(collectionId, token);
  if (!memberId) return null;

  await setContributorSession(collectionId, memberId);
  return memberId;
}

/**
 * "No, that's not me" — the contributor rejects the confirmation screen.
 * Clears the membership pass cookie so they can start again.
 */
export async function rejectMembershipPass(): Promise<void> {
  await clearMembershipPass();
}
