import { describe, expect, it } from "vitest";
import {
  getNotificationDeepLink,
  getNotificationDescription,
  getNotificationLabel,
} from "./notification-display.ts";

describe("getNotificationLabel", () => {
  it("maps known event types to a human label", () => {
    expect(getNotificationLabel("collection.publish")).toBe("Collection published");
    // M13.3: the "still owes payment" variant has its own label so a reader
    // can tell the two apart in the inbox.
    expect(getNotificationLabel("collection.publish_remind_unpaid")).toBe("Payment reminder");
    expect(getNotificationLabel("member.approve_join")).toBe("Membership approved");
    expect(getNotificationLabel("member.join_via_invite")).toBe("New member joined");
  });

  it("falls back to a generic label for unknown types", () => {
    expect(getNotificationLabel("something.unexpected")).toBe("Notification");
    expect(getNotificationLabel("unknown")).toBe("Notification");
  });
});

describe("getNotificationDeepLink", () => {
  it("links a collection notification to the PUBLIC collection page members can open, not the officer dashboard", () => {
    for (const type of ["collection.publish", "collection.remind", "collection.announce_update"]) {
      const link = getNotificationDeepLink(type, { community_slug: "lagos-alumni", collection_slug: "annual-dues" });
      expect(link).toBe("/lagos-alumni/annual-dues");
      expect(link?.startsWith("/c/")).toBe(false);
    }
  });

  it("gives no link (rather than an officer-only list) when the collection slug is missing", () => {
    expect(getNotificationDeepLink("collection.publish", { community_slug: "lagos-alumni" })).toBeNull();
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
    ).toBeNull();
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

  it("the legacy payment-reminder variant is described as a neutral reminder, named when possible", () => {
    expect(
      getNotificationDescription("collection.publish_remind_unpaid", { collection_name: "Annual Dues" }),
    ).toBe("Reminder: Annual Dues");
    expect(getNotificationDescription("collection.publish_remind_unpaid", {})).toBe("A collection reminder");
  });

  it("no reminder text claims the reader owes money (payment status is not recorded)", () => {
    for (const type of ["collection.publish_remind_unpaid", "collection.remind"]) {
      expect(getNotificationDescription(type, { collection_name: "Dues" })).not.toMatch(/owe|outstanding|unpaid/i);
    }
  });

  it("labels and describes reminders and update announcements", () => {
    expect(getNotificationLabel("collection.remind")).toBe("Collection reminder");
    expect(getNotificationLabel("collection.announce_update")).toBe("Collection updated");
    expect(getNotificationDescription("collection.announce_update", { collection_name: "Dues" })).toBe("Dues has been updated");
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
