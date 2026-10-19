import { describe, expect, it } from "vitest";
import {
  getNotificationDeepLink,
  getNotificationDescription,
  getNotificationLabel,
} from "./notification-display.ts";

describe("getNotificationLabel", () => {
  it("maps known event types to a human label", () => {
    expect(getNotificationLabel("collection.publish")).toBe("Collection published");
    expect(getNotificationLabel("member.approve_join")).toBe("Membership approved");
    expect(getNotificationLabel("member.join_via_invite")).toBe("New member joined");
  });

  it("falls back to a generic label for unknown types", () => {
    expect(getNotificationLabel("something.unexpected")).toBe("Notification");
    expect(getNotificationLabel("unknown")).toBe("Notification");
  });
});

describe("getNotificationDeepLink", () => {
  it("links a published collection to its page when both slugs are present", () => {
    expect(
      getNotificationDeepLink("collection.publish", {
        community_slug: "lagos-alumni",
        collection_slug: "annual-dues",
      }),
    ).toBe("/c/lagos-alumni/collections/annual-dues");
  });

  it("falls back to the collections list when the collection slug is missing", () => {
    expect(getNotificationDeepLink("collection.publish", { community_slug: "lagos-alumni" })).toBe(
      "/c/lagos-alumni/collections",
    );
  });

  it("links membership events to the members page", () => {
    expect(getNotificationDeepLink("member.approve_join", { community_slug: "lagos-alumni" })).toBe(
      "/c/lagos-alumni/members",
    );
    expect(getNotificationDeepLink("member.join_via_invite", { community_slug: "lagos-alumni" })).toBe(
      "/c/lagos-alumni/members",
    );
  });

  it("returns null (non-navigating) when the community slug is absent", () => {
    expect(getNotificationDeepLink("collection.publish", {})).toBeNull();
    expect(getNotificationDeepLink("member.approve_join", {})).toBeNull();
  });

  it("returns null for an unknown event type even with a slug", () => {
    expect(getNotificationDeepLink("something.unexpected", { community_slug: "lagos-alumni" })).toBeNull();
  });

  it("ignores a non-string slug rather than building a corrupt path", () => {
    // payload is user/community-controlled; a non-string must not leak into a URL.
    expect(getNotificationDeepLink("collection.publish", { community_slug: 42 })).toBeNull();
    expect(
      getNotificationDeepLink("collection.publish", { community_slug: "lagos-alumni", collection_slug: { a: 1 } }),
    ).toBe("/c/lagos-alumni/collections");
  });
});

describe("getNotificationDescription", () => {
  it("names the collection when present", () => {
    expect(getNotificationDescription("collection.publish", { collection_name: "Annual Dues" })).toBe(
      "Annual Dues is now live",
    );
  });

  it("falls back when the collection name is missing", () => {
    expect(getNotificationDescription("collection.publish", {})).toBe("A collection is now live");
  });

  it("describes an approved membership", () => {
    expect(getNotificationDescription("member.approve_join", {})).toBe("Your membership has been approved");
  });

  it("names the joining member when present, else a generic phrase", () => {
    expect(getNotificationDescription("member.join_via_invite", { member_name: "Ada Obi" })).toBe(
      "Ada Obi joined the community",
    );
    expect(getNotificationDescription("member.join_via_invite", {})).toBe("Someone joined the community");
  });

  it("ignores a non-string member name", () => {
    expect(getNotificationDescription("member.join_via_invite", { member_name: 7 })).toBe(
      "Someone joined the community",
    );
  });

  it("has a safe fallback for unknown event types", () => {
    expect(getNotificationDescription("something.unexpected", {})).toBe("New notification");
  });
});
