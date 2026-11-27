import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ── Mocks ──────────────────────────────────────────────────────────────────

const SECRET = "test-secret-that-is-at-least-32-characters-long";
const COL_ID = "c0000000-0000-4000-8000-000000000001";
const OTHER_COL = "c0000000-0000-4000-8000-000000000002";
const TOKEN = "grant-token-abc123";

let cookieJar: Map<string, { value: string; options: Record<string, unknown> }>;

vi.mock("@kolekto/config", () => ({
  loadSessionSecret: () => SECRET,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    set: (name: string, value: string, options: Record<string, unknown>) => {
      cookieJar.set(name, { value, options });
    },
    get: (name: string) => cookieJar.get(name) ?? undefined,
    delete: (name: string) => {
      cookieJar.delete(name);
    },
  }),
}));

const { setMembershipPass, readMembershipPass, clearMembershipPass } = await import("./membership-pass.ts");

// ── Tests ──────────────────────────────────────────────────────────────────

describe("membership-pass cookie", () => {
  beforeEach(() => {
    cookieJar = new Map();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trips a token for the same collection", async () => {
    await setMembershipPass(COL_ID, TOKEN);
    const result = await readMembershipPass(COL_ID);
    expect(result).toBe(TOKEN);
  });

  it("returns null when no cookie is set", async () => {
    const result = await readMembershipPass(COL_ID);
    expect(result).toBeNull();
  });

  it("returns null for a different collection", async () => {
    await setMembershipPass(COL_ID, TOKEN);
    const result = await readMembershipPass(OTHER_COL);
    expect(result).toBeNull();
  });

  it("returns null for a tampered cookie", async () => {
    await setMembershipPass(COL_ID, TOKEN);
    const entry = cookieJar.get("kolekto_member_pass")!;
    cookieJar.set("kolekto_member_pass", { value: entry.value + "x", options: {} });
    const result = await readMembershipPass(COL_ID);
    expect(result).toBeNull();
  });

  it("returns null after the 30-minute TTL", async () => {
    await setMembershipPass(COL_ID, TOKEN);
    vi.advanceTimersByTime(31 * 60 * 1000);
    const result = await readMembershipPass(COL_ID);
    expect(result).toBeNull();
  });

  it("still returns within the 30-minute TTL", async () => {
    await setMembershipPass(COL_ID, TOKEN);
    vi.advanceTimersByTime(29 * 60 * 1000);
    const result = await readMembershipPass(COL_ID);
    expect(result).toBe(TOKEN);
  });

  it("returns null for garbage cookie value", async () => {
    cookieJar.set("kolekto_member_pass", { value: "not-valid-at-all", options: {} });
    const result = await readMembershipPass(COL_ID);
    expect(result).toBeNull();
  });

  it("clearMembershipPass removes the cookie", async () => {
    await setMembershipPass(COL_ID, TOKEN);
    await clearMembershipPass();
    const result = await readMembershipPass(COL_ID);
    expect(result).toBeNull();
  });

  it("sets httpOnly and sameSite on the cookie", async () => {
    await setMembershipPass(COL_ID, TOKEN);
    const entry = cookieJar.get("kolekto_member_pass")!;
    expect(entry.options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 60,
    });
  });
});
