import "server-only";

import { isIPv4, isIPv6 } from "node:net";
import { ConfigError, loadClientIpSource, type ClientIpSource } from "@kolekto/config";
import { headers } from "next/headers";
import { logEvent } from "./server-log.ts";

/**
 * client-ip.ts — the ONE place the web server decides who a caller is for
 * IP-based rate limiting (session 67, Phase 2).
 *
 * Before this, `membership-pass-helpers.ts` took the FIRST `X-Forwarded-For`
 * entry. That entry is written by the caller: `next start` fills the header
 * from the socket only when it is absent, and every common proxy appends to it
 * rather than replacing it. Sending a new value per request gave a new
 * rate-limit bucket per request, so the per-IP limit in
 * `app.validate_membership_id` never triggered and one client could spend a
 * collection's shared failure budget and lock every member out.
 *
 * Now the trusted source is configured per deployment (`KOLEKTO_CLIENT_IP_SOURCE`,
 * see `loadClientIpSource` in @kolekto/config) and nothing else is read:
 *
 *   local        rightmost X-Forwarded-For entry (KOLEKTO_ENV=local only)
 *   vercel       `x-vercel-forwarded-for`, exactly one address
 *   xff-hops:N   Nth X-Forwarded-For entry from the right; entries further
 *                left were written by the caller and are ignored
 *
 * Anything that cannot be resolved with certainty — no or bad configuration,
 * a missing header, a malformed or oversized value, a chain shorter than the
 * configured hops — is a failure the caller must treat as "temporarily
 * unavailable". There is no shared "unknown" bucket and no fallback to a
 * different header.
 *
 * The result is a canonical identity string (`ip4:<address>` or
 * `ip6-64:<prefix>::/64`), which callers hash (`hashClientAddress`) before it
 * leaves the process. No raw address or header value is ever logged.
 *
 * IPv6 is keyed by its /64 prefix. Privacy addressing and mobile networks
 * rotate the low 64 bits freely, so per-address keys would let a single device
 * (or a single attacker with one ordinary allocation) appear as unlimited
 * callers. A /64 is normally one subscriber or one LAN, so this is as fair as
 * today's IPv4 NAT keying; an attacker holding many /64s can still rotate
 * between them, which the collection/community limits in SQL still bound.
 */

/** The subset of `Headers` the resolver needs; `headers()` and `new Headers()` both satisfy it. */
export interface HeaderReader {
  get(name: string): string | null;
}

export type ClientIdentityFailure =
  | "config_missing_or_invalid"
  | "header_missing"
  | "header_malformed"
  | "chain_too_short";

export type ClientIdentityResult =
  | { readonly ok: true; readonly identity: string }
  | { readonly ok: false; readonly reason: ClientIdentityFailure };

/** Longest header value considered at all. A proxy chain of a few hops is far shorter; longer is refused. */
export const MAX_HEADER_LENGTH = 2048;
/** Longest single entry: a bracketed IPv6 address with a port is well under this. */
const MAX_ENTRY_LENGTH = 64;

const VERCEL_HEADER = "x-vercel-forwarded-for";
const XFF_HEADER = "x-forwarded-for";

type ParsedAddress = { readonly family: 4; readonly octets: readonly number[] } | { readonly family: 6; readonly groups: readonly number[] };

function parseIPv4(text: string): ParsedAddress | null {
  // node:net rejects out-of-range octets, leading zeros and short forms.
  if (!isIPv4(text)) return null;
  return { family: 4, octets: text.split(".").map(Number) };
}

/** Eight 16-bit groups, or null. Expects text `isIPv6` already accepted (no zone id). */
function expandIPv6(text: string): number[] | null {
  let s = text.toLowerCase();
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (!v4 || v4.family !== 4) return null;
    const [a, b, c, d] = v4.octets as [number, number, number, number];
    s = `${s.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

/**
 * One address as a proxy writes it: `203.0.113.5`, `203.0.113.5:443`,
 * `2001:db8::1`, `[2001:db8::1]`, `[2001:db8::1]:443`. Surrounding whitespace
 * is ignored. Zone ids (`%eth0`), quotes, obfuscated forms and anything else
 * are refused. IPv4-mapped IPv6 (`::ffff:192.0.2.1`) becomes the IPv4 address.
 */
export function parseClientAddress(entry: string): ParsedAddress | null {
  const text = entry.trim();
  if (text === "" || text.length > MAX_ENTRY_LENGTH || text.includes("%")) return null;

  let host = text;
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(text);
  if (bracketed) {
    if (bracketed[2] !== undefined && Number(bracketed[2]) > 65535) return null;
    host = bracketed[1]!;
    if (!isIPv6(host)) return null;
  } else if (text.startsWith("[")) {
    return null;
  } else {
    const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(text);
    if (withPort) {
      if (Number(withPort[2]) > 65535) return null;
      host = withPort[1]!;
    }
  }

  const v4 = parseIPv4(host);
  if (v4) return v4;
  if (!isIPv6(host)) return null;
  const groups = expandIPv6(host);
  if (!groups) return null;
  const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (mapped) {
    const hi = groups[6]!;
    const lo = groups[7]!;
    return { family: 4, octets: [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff] };
  }
  return { family: 6, groups };
}

/** The canonical rate-limit identity: `ip4:<a.b.c.d>` or `ip6-64:<first four groups>::/64`. */
export function rateLimitIdentity(address: ParsedAddress): string {
  if (address.family === 4) return `ip4:${address.octets.join(".")}`;
  return `ip6-64:${address.groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

function identityOf(entry: string): ClientIdentityResult {
  const parsed = parseClientAddress(entry);
  return parsed ? { ok: true, identity: rateLimitIdentity(parsed) } : { ok: false, reason: "header_malformed" };
}

function readHeader(headerList: HeaderReader, name: string): { value: string } | { failure: ClientIdentityFailure } {
  const value = headerList.get(name);
  if (value === null || value.trim() === "") return { failure: "header_missing" };
  if (value.length > MAX_HEADER_LENGTH) return { failure: "header_malformed" };
  return { value };
}

/**
 * Pure resolution from request headers and the configured source. Never
 * throws for any header input; reads ONLY the header the source names.
 */
export function resolveClientIdentity(headerList: HeaderReader, source: ClientIpSource): ClientIdentityResult {
  switch (source.mode) {
    case "vercel": {
      const read = readHeader(headerList, VERCEL_HEADER);
      if ("failure" in read) return { ok: false, reason: read.failure };
      // Documented as one address. A list (or a repeated header, which Headers joins with ", ") is not trusted.
      if (read.value.includes(",")) return { ok: false, reason: "header_malformed" };
      return identityOf(read.value);
    }
    case "xff-hops": {
      const read = readHeader(headerList, XFF_HEADER);
      if ("failure" in read) return { ok: false, reason: read.failure };
      const entries = read.value.split(",");
      if (entries.length < source.hops) return { ok: false, reason: "chain_too_short" };
      // The rightmost `hops` entries were appended by trusted proxies; every one must be a real address.
      const trusted = entries.slice(entries.length - source.hops);
      if (trusted.some((entry) => parseClientAddress(entry) === null)) return { ok: false, reason: "header_malformed" };
      return identityOf(trusted[0]!);
    }
    case "local": {
      const read = readHeader(headerList, XFF_HEADER);
      if ("failure" in read) return { ok: false, reason: read.failure };
      const entries = read.value.split(",");
      return identityOf(entries[entries.length - 1]!);
    }
    default: {
      const unknown: never = source;
      void unknown;
      return { ok: false, reason: "config_missing_or_invalid" };
    }
  }
}

/**
 * The caller of the current request, from the configured trusted source.
 * Logs a reason code (never an address or header value) when it cannot.
 */
export async function resolveCallerIdentity(): Promise<ClientIdentityResult> {
  let source: ClientIpSource;
  try {
    source = loadClientIpSource();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    // The ConfigError message names the variable and the allowed values; it never repeats the configured value.
    logEvent("error", "client_ip.unresolved", { reason: "config_missing_or_invalid", detail: err.message });
    return { ok: false, reason: "config_missing_or_invalid" };
  }
  const result = resolveClientIdentity(await headers(), source);
  if (!result.ok) logEvent("warn", "client_ip.unresolved", { reason: result.reason, source: source.mode });
  return result;
}
