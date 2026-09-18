import { describe, expect, it } from "vitest";
import { formatDistanceToNow } from "./format.ts";

describe("formatDistanceToNow", () => {
  it("reads 'just now' for anything under a minute", () => {
    expect(formatDistanceToNow(new Date().toISOString())).toBe("just now");
  });

  it("reads in minutes between one minute and one hour", () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatDistanceToNow(fiveMinutesAgo)).toBe("5m ago");
  });

  it("reads in hours between one hour and one day", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
    expect(formatDistanceToNow(threeHoursAgo)).toBe("3h ago");
  });

  it("falls back to a calendar date beyond 30 days", () => {
    const longAgo = new Date(Date.now() - 40 * 86_400_000);
    expect(formatDistanceToNow(longAgo.toISOString())).toBe(longAgo.toLocaleDateString());
  });
});
