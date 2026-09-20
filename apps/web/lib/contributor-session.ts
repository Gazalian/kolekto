import "server-only";

import { loadSessionSecret } from "@kolekto/config";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

/**
 * Who a contributor said they are, remembered between two requests.
 *
 * A contributor is not a user (PRD 0.3). They have no account, no password and
 * no Supabase session, and M7 does not give them one — creating an auth user
 * just to take somebody's dues would turn every payer into a login, which is
 * exactly the thing the product refuses to do.
 *
 * What the server does need to remember, between "yes, that is me" and the
 * payment boundary, is which member of which collection they identified as.
 * That lives here, in an httpOnly cookie, signed:
 *
 *   · httpOnly, so no script on the page can read it;
 *   · signed, so nothing can WRITE it — a member id is the one value a browser
 *     must not be able to choose, since choosing it means becoming somebody
 *     else on the roll;
 *   · scoped to one collection, so an identification on one page is not an
 *     identification on another;
 *   · short-lived, because it is a checkout, not a login.
 *
 * It carries ids and nothing else. No name, no phone, no identifier — a cookie
 * is a file on somebody's phone, and none of that belongs there.
 *
 * The cookie is a CONVENIENCE, never an authority: every read re-checks the
 * member against the database (`app.get_collection_member_context`), which is
 * what actually decides whether they are still eligible.
 */

const COOKIE = "kolekto_contributor";
const MAX_AGE_SECONDS = 60 * 60; // One hour. Long enough to pay, short enough not to linger.

interface ContributorSession {
  collectionId: string;
  memberId: string;
  /** Seconds since the epoch, checked on read so an old cookie cannot be replayed indefinitely. */
  issuedAt: number;
}

function sign(payload: string): string {
  return createHmac("sha256", loadSessionSecret()).update(payload).digest("base64url");
}

function verify(payload: string, signature: string): boolean {
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  // Length check first: timingSafeEqual throws on a length mismatch, and a
  // thrown exception is itself a signal about the input.
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** Records that this browser identified as this member, on this collection. */
export async function setContributorSession(collectionId: string, memberId: string): Promise<void> {
  const session: ContributorSession = { collectionId, memberId, issuedAt: Math.floor(Date.now() / 1000) };
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");

  (await cookies()).set(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: "lax",
    // Set over plain HTTP in local development; the deployed app is HTTPS-only.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

/**
 * The member this browser identified as for this collection, or `null`.
 *
 * Returns null for a tampered cookie, an expired one, and one issued for a
 * different collection — all silently, because a contributor cannot act on the
 * difference and an attacker should not learn it.
 */
export async function readContributorSession(collectionId: string): Promise<string | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;

  const separator = raw.lastIndexOf(".");
  if (separator <= 0) return null;

  const payload = raw.slice(0, separator);
  if (!verify(payload, raw.slice(separator + 1))) return null;

  let session: ContributorSession;
  try {
    session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ContributorSession;
  } catch {
    return null;
  }

  if (typeof session.memberId !== "string" || typeof session.collectionId !== "string") return null;
  if (session.collectionId !== collectionId) return null;
  if (Math.floor(Date.now() / 1000) - session.issuedAt > MAX_AGE_SECONDS) return null;

  return session.memberId;
}

/** Forgets the identification — "not me", or starting again. */
export async function clearContributorSession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}
