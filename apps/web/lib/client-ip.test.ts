import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ── Mocks for the server wrapper (resolveCallerIdentity) ────────────────────

class FakeConfigError extends Error {}
let sourceResult: (() => unknown) | null = null;
let requestHeaders = new Headers();
const logged: { level: string; msg: string; fields: Record<string, unknown> }[] = [];

vi.mock("@kolekto/config", () => ({
  ConfigError: FakeConfigError,
  loadClientIpSource: () => {
    if (!sourceResult) throw new Error("test did not set a source");
    return sourceResult();
  },
}));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));
vi.mock("./server-log.ts", () => ({
  logEvent: (level: string, msg: string, fields: Record<string, unknown> = {}) => logged.push({ level, msg, fields }),
}));

const { MAX_HEADER_LENGTH, parseClientAddress, rateLimitIdentity, resolveClientIdentity, resolveCallerIdentity } =
  await import("./client-ip.ts");

type Source = Parameters<typeof resolveClientIdentity>[1];
const LOCAL: Source = { mode: "local" };
const VERCEL: Source = { mode: "vercel" };
const hops = (n: 1 | 2 | 3): Source => ({ mode: "xff-hops", hops: n });

function h(entries: Record<string, string | string[]>): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(entries)) {
    for (const v of Array.isArray(value) ? value : [value]) out.append(name, v);
  }
  return out;
}

function identity(entry: string): string | null {
  const parsed = parseClientAddress(entry);
  return parsed ? rateLimitIdentity(parsed) : null;
}

// ── Normalisation ────────────────────────────────────────────────────────────

describe("parseClientAddress + rateLimitIdentity: IPv4", () => {
  it.each([
    ["203.0.113.5", "ip4:203.0.113.5"],
    ["  203.0.113.5  ", "ip4:203.0.113.5"],
    ["0.0.0.0", "ip4:0.0.0.0"],
    ["255.255.255.255", "ip4:255.255.255.255"],
    ["203.0.113.5:443", "ip4:203.0.113.5"],
    ["203.0.113.5:0", "ip4:203.0.113.5"],
  ])("%s → %s", (input, expected) => {
    expect(identity(input)).toBe(expected);
  });

  it.each([
    "256.0.0.1", "203.0.113", "203.0.113.5.6", "203.0.113.05", "0203.0.113.5", "1.2.3.-4", "1.2.3.4/24",
    "203.0.113.5:65536", "203.0.113.5:", "203.0.113.5:abc", "0x7f.0.0.1", "2130706433", "1.2.3.4 5.6.7.8",
    "\"203.0.113.5\"", "unknown", "", "   ", "localhost",
  ])("refuses %j", (input) => {
    expect(parseClientAddress(input)).toBeNull();
  });
});

describe("parseClientAddress + rateLimitIdentity: IPv6 (keyed by /64)", () => {
  it.each([
    ["2001:db8:1:2:3:4:5:6", "ip6-64:2001:db8:1:2::/64"],
    ["2001:DB8:1:2::ABCD", "ip6-64:2001:db8:1:2::/64"],
    ["2001:0db8:0001:0002:0000:0000:0000:0001", "ip6-64:2001:db8:1:2::/64"],
    ["[2001:db8:1:2::1]", "ip6-64:2001:db8:1:2::/64"],
    ["[2001:db8:1:2::1]:8080", "ip6-64:2001:db8:1:2::/64"],
    ["2001:db8::", "ip6-64:2001:db8:0:0::/64"],
    ["::1", "ip6-64:0:0:0:0::/64"],
    ["::", "ip6-64:0:0:0:0::/64"],
  ])("%s → %s", (input, expected) => {
    expect(identity(input)).toBe(expected);
  });

  it("puts privacy/rotating addresses inside one /64 in the same bucket", () => {
    const a = identity("2001:db8:aa:bb:1111:2222:3333:4444");
    expect(identity("2001:db8:aa:bb:ffff:eeee:dddd:cccc")).toBe(a);
    expect(identity("2001:db8:aa:bb::1")).toBe(a);
  });

  it("keeps different /64s apart", () => {
    expect(identity("2001:db8:aa:bb::1")).not.toBe(identity("2001:db8:aa:bc::1"));
    expect(identity("2001:db8:aa:bb::1")).not.toBe(identity("2001:db9:aa:bb::1"));
  });

  it("maps IPv4-mapped IPv6 to the same identity as the IPv4 address", () => {
    expect(identity("::ffff:192.0.2.1")).toBe("ip4:192.0.2.1");
    expect(identity("::FFFF:192.0.2.1")).toBe("ip4:192.0.2.1");
    expect(identity("::ffff:c000:201")).toBe("ip4:192.0.2.1");
    expect(identity("[::ffff:192.0.2.1]:443")).toBe("ip4:192.0.2.1");
    expect(identity("0:0:0:0:0:ffff:192.0.2.1")).toBe(identity("192.0.2.1"));
  });

  it.each([
    "fe80::1%eth0", "[fe80::1%25eth0]", "2001:db8::1::2", "2001:db8:1:2:3:4:5:6:7", "2001:db8:g::1", "12345::1",
    "[2001:db8::1", "2001:db8::1]", "[2001:db8::1]:", "[2001:db8::1]:99999", "[203.0.113.5]", "::ffff:999.0.2.1",
    ":::", "[]", `${"1:".repeat(40)}1`,
  ])("refuses %j", (input) => {
    expect(parseClientAddress(input)).toBeNull();
  });
});

// ── local ────────────────────────────────────────────────────────────────────

describe("local mode", () => {
  it("uses the rightmost X-Forwarded-For entry (what next start/dev fills from the socket)", () => {
    expect(resolveClientIdentity(h({ "x-forwarded-for": "::1" }), LOCAL)).toEqual({ ok: true, identity: "ip6-64:0:0:0:0::/64" });
    expect(resolveClientIdentity(h({ "x-forwarded-for": "::ffff:127.0.0.1" }), LOCAL)).toEqual({ ok: true, identity: "ip4:127.0.0.1" });
    expect(resolveClientIdentity(h({ "x-forwarded-for": "198.51.100.1, 127.0.0.1" }), LOCAL)).toEqual({ ok: true, identity: "ip4:127.0.0.1" });
  });

  it("fails closed with no header or a malformed one (no shared bucket)", () => {
    expect(resolveClientIdentity(h({}), LOCAL)).toEqual({ ok: false, reason: "header_missing" });
    expect(resolveClientIdentity(h({ "x-forwarded-for": "nonsense" }), LOCAL)).toEqual({ ok: false, reason: "header_malformed" });
  });

  it("does not read x-real-ip", () => {
    expect(resolveClientIdentity(h({ "x-real-ip": "203.0.113.5" }), LOCAL)).toEqual({ ok: false, reason: "header_missing" });
  });
});

// ── vercel (staging) ─────────────────────────────────────────────────────────

describe("vercel mode (simulated documented behaviour: Vercel sets x-vercel-forwarded-for to the connecting IP)", () => {
  const REAL = "198.51.100.7";

  it("uses x-vercel-forwarded-for", () => {
    expect(resolveClientIdentity(h({ "x-vercel-forwarded-for": REAL }), VERCEL)).toEqual({ ok: true, identity: `ip4:${REAL}` });
    expect(resolveClientIdentity(h({ "x-vercel-forwarded-for": "2001:db8:5:6::9" }), VERCEL)).toEqual({
      ok: true,
      identity: "ip6-64:2001:db8:5:6::/64",
    });
  });

  it("SPOOFING: forged X-Forwarded-For / X-Real-IP values cannot change the identity", () => {
    const forgedA = h({ "x-vercel-forwarded-for": REAL, "x-forwarded-for": "1.1.1.1", "x-real-ip": "2.2.2.2" });
    const forgedB = h({ "x-vercel-forwarded-for": REAL, "x-forwarded-for": "9.9.9.9, 8.8.8.8", "x-real-ip": "7.7.7.7" });
    const plain = h({ "x-vercel-forwarded-for": REAL });
    const a = resolveClientIdentity(forgedA, VERCEL);
    expect(a).toEqual({ ok: true, identity: `ip4:${REAL}` });
    expect(resolveClientIdentity(forgedB, VERCEL)).toEqual(a);
    expect(resolveClientIdentity(plain, VERCEL)).toEqual(a);
  });

  it("fails closed when the trusted header is missing, even if X-Forwarded-For / X-Real-IP are present", () => {
    expect(resolveClientIdentity(h({ "x-forwarded-for": REAL, "x-real-ip": REAL }), VERCEL)).toEqual({
      ok: false,
      reason: "header_missing",
    });
    expect(resolveClientIdentity(h({ "x-vercel-forwarded-for": "   " }), VERCEL)).toEqual({ ok: false, reason: "header_missing" });
  });

  it("fails closed on a list, a repeated header, or a malformed value", () => {
    expect(resolveClientIdentity(h({ "x-vercel-forwarded-for": `${REAL}, 1.1.1.1` }), VERCEL)).toEqual({ ok: false, reason: "header_malformed" });
    expect(resolveClientIdentity(h({ "x-vercel-forwarded-for": [REAL, "1.1.1.1"] }), VERCEL)).toEqual({ ok: false, reason: "header_malformed" });
    expect(resolveClientIdentity(h({ "x-vercel-forwarded-for": "unknown" }), VERCEL)).toEqual({ ok: false, reason: "header_malformed" });
    expect(resolveClientIdentity(h({ "x-vercel-forwarded-for": "fe80::1%eth0" }), VERCEL)).toEqual({ ok: false, reason: "header_malformed" });
  });

  it("refuses an oversized header", () => {
    // Headers trims surrounding whitespace, so the padding has to be part of the value itself.
    const oversized = `${"0".repeat(MAX_HEADER_LENGTH)}${REAL}`;
    expect(resolveClientIdentity(h({ "x-vercel-forwarded-for": oversized }), VERCEL)).toEqual({
      ok: false,
      reason: "header_malformed",
    });
  });
});

// ── xff-hops (AWS shapes, simulated; production value is PENDING) ────────────

describe("xff-hops mode", () => {
  const CLIENT = "198.51.100.23";
  const EDGE = "130.176.1.10";

  it("ALB only (xff-hops:1): the ALB-appended rightmost entry is the client", () => {
    expect(resolveClientIdentity(h({ "x-forwarded-for": CLIENT }), hops(1))).toEqual({ ok: true, identity: `ip4:${CLIENT}` });
  });

  it("SPOOFING, ALB only: whatever the caller puts on the left is ignored", () => {
    const a = resolveClientIdentity(h({ "x-forwarded-for": `1.1.1.1, ${CLIENT}` }), hops(1));
    const b = resolveClientIdentity(h({ "x-forwarded-for": `9.9.9.9, 8.8.8.8, ${CLIENT}` }), hops(1));
    const c = resolveClientIdentity(h({ "x-forwarded-for": `garbage, %%, [::, ${CLIENT}` }), hops(1));
    expect(a).toEqual({ ok: true, identity: `ip4:${CLIENT}` });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("CloudFront → ALB (xff-hops:2): `…, viewer, edge` → the viewer", () => {
    expect(resolveClientIdentity(h({ "x-forwarded-for": `${CLIENT}, ${EDGE}` }), hops(2))).toEqual({ ok: true, identity: `ip4:${CLIENT}` });
  });

  it("SPOOFING, CloudFront → ALB: forged entries and forged X-Real-IP do not change the identity", () => {
    const a = resolveClientIdentity(h({ "x-forwarded-for": `1.1.1.1, ${CLIENT}, ${EDGE}`, "x-real-ip": "5.5.5.5" }), hops(2));
    const b = resolveClientIdentity(h({ "x-forwarded-for": `2.2.2.2, 3.3.3.3, ${CLIENT}, ${EDGE}`, "x-real-ip": "6.6.6.6" }), hops(2));
    expect(a).toEqual({ ok: true, identity: `ip4:${CLIENT}` });
    expect(b).toEqual(a);
  });

  it("DIRECT-ORIGIN BYPASS is an infrastructure property: hitting the ALB directly makes a forged entry the 'client'", () => {
    // Attacker sends `X-Forwarded-For: 4.4.4.4` straight to the ALB; the ALB appends the attacker's real address.
    // With xff-hops:2 the resolver cannot tell this from a CloudFront request, so production docs REQUIRE
    // the origin to be reachable only through CloudFront. This test documents the limit; it does not pass the fix.
    const direct = resolveClientIdentity(h({ "x-forwarded-for": `4.4.4.4, ${CLIENT}` }), hops(2));
    expect(direct).toEqual({ ok: true, identity: "ip4:4.4.4.4" });
  });

  it("accepts ALB IPv6 forms (bracketed, with port) and ALB client-port entries", () => {
    expect(resolveClientIdentity(h({ "x-forwarded-for": "1.1.1.1, [2001:db8:7:8::1]:51234" }), hops(1))).toEqual({
      ok: true,
      identity: "ip6-64:2001:db8:7:8::/64",
    });
    expect(resolveClientIdentity(h({ "x-forwarded-for": `${CLIENT}:51234` }), hops(1))).toEqual({ ok: true, identity: `ip4:${CLIENT}` });
  });

  it("joins repeated X-Forwarded-For headers in order (as Headers does) and still takes the right hop", () => {
    expect(resolveClientIdentity(h({ "x-forwarded-for": ["1.1.1.1", `${CLIENT}, ${EDGE}`] }), hops(2))).toEqual({
      ok: true,
      identity: `ip4:${CLIENT}`,
    });
  });

  it("fails closed when the chain is shorter than the configured hops", () => {
    expect(resolveClientIdentity(h({ "x-forwarded-for": CLIENT }), hops(2))).toEqual({ ok: false, reason: "chain_too_short" });
    expect(resolveClientIdentity(h({ "x-forwarded-for": `${CLIENT}, ${EDGE}` }), hops(3))).toEqual({ ok: false, reason: "chain_too_short" });
  });

  it("fails closed when any trusted (rightmost) entry is malformed or empty", () => {
    expect(resolveClientIdentity(h({ "x-forwarded-for": `${CLIENT}, not-an-ip` }), hops(2))).toEqual({ ok: false, reason: "header_malformed" });
    expect(resolveClientIdentity(h({ "x-forwarded-for": `not-an-ip, ${EDGE}` }), hops(2))).toEqual({ ok: false, reason: "header_malformed" });
    expect(resolveClientIdentity(h({ "x-forwarded-for": `${CLIENT}, ` }), hops(1))).toEqual({ ok: false, reason: "header_malformed" });
    expect(resolveClientIdentity(h({ "x-forwarded-for": ", , ," }), hops(2))).toEqual({ ok: false, reason: "header_malformed" });
  });

  it("fails closed when the header is missing (does not fall back to X-Real-IP or the Vercel header)", () => {
    expect(resolveClientIdentity(h({ "x-real-ip": CLIENT, "x-vercel-forwarded-for": CLIENT }), hops(1))).toEqual({
      ok: false,
      reason: "header_missing",
    });
  });

  it("refuses an oversized chain (a caller can only refuse its own request this way)", () => {
    const huge = `${"1.1.1.1, ".repeat(400)}${CLIENT}`;
    expect(huge.length).toBeGreaterThan(MAX_HEADER_LENGTH);
    expect(resolveClientIdentity(h({ "x-forwarded-for": huge }), hops(1))).toEqual({ ok: false, reason: "header_malformed" });
  });
});

describe("never throws, whatever the header", () => {
  const inputs = ["", ",", ",,,,", "[", "]", "::::", "%", "\u0000", "é", "1.2.3.4,".repeat(300), "[::1]:99999", " , 1.1.1.1 , "];
  it.each(inputs)("%j", (value) => {
    for (const source of [LOCAL, VERCEL, hops(1), hops(2), hops(3)]) {
      const headersWith = new Headers();
      try {
        headersWith.set("x-forwarded-for", value);
        headersWith.set("x-vercel-forwarded-for", value);
      } catch {
        continue; // Headers itself refuses some control characters; such a request never reaches the resolver.
      }
      expect(() => resolveClientIdentity(headersWith, source)).not.toThrow();
    }
  });
});

// ── Rate-limit identity consistency ──────────────────────────────────────────

describe("rate-limit identity consistency", () => {
  it("the same caller gets the same identity across spellings and sources", () => {
    const ids = [
      resolveClientIdentity(h({ "x-vercel-forwarded-for": "2001:DB8:1:2::5" }), VERCEL),
      resolveClientIdentity(h({ "x-forwarded-for": "9.9.9.9, [2001:db8:1:2:0:0:0:5]:443" }), hops(1)),
      resolveClientIdentity(h({ "x-forwarded-for": "2001:0db8:0001:0002::0005" }), LOCAL),
    ];
    expect(new Set(ids.map((r) => JSON.stringify(r))).size).toBe(1);
  });

  it("identities never contain anything but the normalised address", () => {
    const r = resolveClientIdentity(h({ "x-vercel-forwarded-for": " 203.0.113.9 " }), VERCEL);
    expect(r).toEqual({ ok: true, identity: "ip4:203.0.113.9" });
  });
});

// ── Server wrapper ───────────────────────────────────────────────────────────

describe("resolveCallerIdentity()", () => {
  beforeEach(() => {
    logged.length = 0;
    requestHeaders = new Headers();
    sourceResult = null;
  });

  it("resolves from the configured source and logs nothing on success", async () => {
    sourceResult = () => VERCEL;
    requestHeaders = h({ "x-vercel-forwarded-for": "203.0.113.9", "x-forwarded-for": "1.1.1.1" });
    expect(await resolveCallerIdentity()).toEqual({ ok: true, identity: "ip4:203.0.113.9" });
    expect(logged).toHaveLength(0);
  });

  it("fails closed on a configuration error and logs only a reason code", async () => {
    sourceResult = () => {
      throw new FakeConfigError("KOLEKTO_CLIENT_IP_SOURCE is not set.");
    };
    requestHeaders = h({ "x-forwarded-for": "203.0.113.9" });
    expect(await resolveCallerIdentity()).toEqual({ ok: false, reason: "config_missing_or_invalid" });
    expect(logged).toHaveLength(1);
    expect(logged[0]!.fields.reason).toBe("config_missing_or_invalid");
    expect(JSON.stringify(logged)).not.toContain("203.0.113.9");
  });

  it("rethrows anything that is not a ConfigError (a bug, not configuration)", async () => {
    sourceResult = () => {
      throw new TypeError("boom");
    };
    await expect(resolveCallerIdentity()).rejects.toThrow("boom");
  });

  it("logs a reason code without the raw address or header value when resolution fails", async () => {
    sourceResult = () => hops(2);
    requestHeaders = h({ "x-forwarded-for": "203.0.113.9", "x-real-ip": "198.51.100.4" });
    expect(await resolveCallerIdentity()).toEqual({ ok: false, reason: "chain_too_short" });
    expect(logged).toEqual([{ level: "warn", msg: "client_ip.unresolved", fields: { reason: "chain_too_short", source: "xff-hops" } }]);
    expect(JSON.stringify(logged)).not.toMatch(/203\.0\.113\.9|198\.51\.100\.4/);
  });
});
