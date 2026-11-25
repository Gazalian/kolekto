import "server-only";

import { loadSessionSecret } from "@kolekto/config";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

/**
 * The membership pass cookie: an httpOnly store for the 30-minute access grant
 * token that app.validate_membership_id returns.
 *
 * This is NOT the contributor-session cookie. The contributor session stores a
 * member UUID. This cookie stores an opaque token valid for 30 minutes. After
 * "yes, that is me" the member UUID also goes into the contributor session,
 * and this cookie is kept (M10): checkout sends the token to the database,
 * which re-resolves the pass and requires it to name the session's member.
 * It is cleared by "not me", by a refused membership proof at checkout, or by
 * its own expiry. The token never reaches the browser's scripts or a log.
 *
 * Same signing pattern as contributor-session.ts: HMAC-SHA256 with the session
 * secret. Same httpOnly / sameSite / secure rules. The cookie name is distinct
 * so the two never collide.
 */

const COOKIE = "kolekto_member_pass";
const MAX_AGE_SECONDS = 30 * 60; // 30 minutes — matches the SQL access grant TTL.

interface MembershipPassPayload {
  collectionId: string;
  token: string;
  issuedAt: number;
}

function sign(payload: string): string {
  return createHmac("sha256", loadSessionSecret()).update(payload).digest("base64url");
}

function verify(payload: string, signature: string): boolean {
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export async function setMembershipPass(collectionId: string, token: string): Promise<void> {
  const data: MembershipPassPayload = {
    collectionId,
    token,
    issuedAt: Math.floor(Date.now() / 1000),
  };
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");

  (await cookies()).set(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function readMembershipPass(collectionId: string): Promise<string | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;

  const separator = raw.lastIndexOf(".");
  if (separator <= 0) return null;

  const payloadStr = raw.slice(0, separator);
  if (!verify(payloadStr, raw.slice(separator + 1))) return null;

  let data: MembershipPassPayload;
  try {
    data = JSON.parse(Buffer.from(payloadStr, "base64url").toString("utf8")) as MembershipPassPayload;
  } catch {
    return null;
  }

  if (typeof data.token !== "string" || typeof data.collectionId !== "string") return null;
  if (data.collectionId !== collectionId) return null;
  if (Math.floor(Date.now() / 1000) - data.issuedAt > MAX_AGE_SECONDS) return null;

  return data.token;
}

export async function clearMembershipPass(): Promise<void> {
  (await cookies()).delete(COOKIE);
}
