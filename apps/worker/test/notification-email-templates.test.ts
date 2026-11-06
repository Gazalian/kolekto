import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  escapeHtml,
  hasTemplate,
  renderTemplate,
  buildTemplatedMessage,
  type EventContext,
} from "../src/notification-email-templates.ts";
import { buildEmailMessage, buildPlaceholderMessage } from "../src/notification-send-message.ts";
import { assertValidEmailRequest } from "@kolekto/adapters";

// ── escapeHtml ──────────────────────────────────────────────────────────────

describe("escapeHtml", () => {
  it("escapes the five dangerous characters", () => {
    assert.equal(escapeHtml('&<>"\''), "&amp;&lt;&gt;&quot;&#39;");
  });

  it("leaves safe text alone", () => {
    assert.equal(escapeHtml("Hello World 123"), "Hello World 123");
  });

  it("handles empty string", () => {
    assert.equal(escapeHtml(""), "");
  });
});

// ── hasTemplate ─────────────────────────────────────────────────────────────

describe("hasTemplate", () => {
  it("returns true for the four email-evaluation events", () => {
    assert.equal(hasTemplate("member.create"), true);
    assert.equal(hasTemplate("member.approve_join"), true);
    assert.equal(hasTemplate("officer_invitation.accept"), true);
    assert.equal(hasTemplate("officer_term.end"), true);
  });

  it("returns false for non-template events", () => {
    assert.equal(hasTemplate("collection.publish"), false);
    assert.equal(hasTemplate("member.reject_join"), false);
    assert.equal(hasTemplate("member.join_via_invite"), false);
    assert.equal(hasTemplate("unknown.action"), false);
  });
});

// ── renderTemplate — correct subjects ───────────────────────────────────────

describe("renderTemplate — subjects", () => {
  it("member.create: membership confirmation subject", () => {
    const result = renderTemplate({
      eventType: "member.create",
      payload: { community_name: "Test Community", member_code: "TC/001" },
    });
    assert.ok(result);
    assert.ok(result.subject.includes("added to"));
    assert.ok(result.subject.includes("Test Community"));
  });

  it("member.approve_join: approval subject", () => {
    const result = renderTemplate({
      eventType: "member.approve_join",
      payload: { community_name: "My Group", member_code: "MG/042" },
    });
    assert.ok(result);
    assert.ok(result.subject.includes("approved to join"));
    assert.ok(result.subject.includes("My Group"));
  });

  it("officer_invitation.accept: appointment subject", () => {
    const result = renderTemplate({
      eventType: "officer_invitation.accept",
      payload: { community_name: "Council", officer_role: "treasurer" },
    });
    assert.ok(result);
    assert.ok(result.subject.includes("treasurer"));
    assert.ok(result.subject.includes("Council"));
  });

  it("officer_term.end: term end subject", () => {
    const result = renderTemplate({
      eventType: "officer_term.end",
      payload: { community_name: "Board", officer_role: "admin" },
    });
    assert.ok(result);
    assert.ok(result.subject.includes("admin"));
    assert.ok(result.subject.includes("ended"));
  });

  it("returns null for unsupported event types", () => {
    assert.equal(renderTemplate({ eventType: "collection.publish", payload: {} }), null);
  });
});

// ── renderTemplate — HTML content ───────────────────────────────────────────

describe("renderTemplate — HTML content", () => {
  it("member.create HTML contains community name and member code", () => {
    const result = renderTemplate({
      eventType: "member.create",
      payload: { community_name: "Kolekto FC", member_code: "KFC/001" },
    })!;
    assert.ok(result.html.includes("Kolekto FC"));
    assert.ok(result.html.includes("KFC/001"));
    assert.ok(result.html.includes("added to"));
  });

  it("officer_invitation.accept HTML contains role and community", () => {
    const result = renderTemplate({
      eventType: "officer_invitation.accept",
      payload: { community_name: "Dev Team", officer_role: "owner" },
    })!;
    assert.ok(result.html.includes("owner"));
    assert.ok(result.html.includes("Dev Team"));
  });
});

// ── renderTemplate — plain-text content ─────────────────────────────────────

describe("renderTemplate — plain-text alternatives", () => {
  it("member.create text contains the same essential info as HTML", () => {
    const result = renderTemplate({
      eventType: "member.create",
      payload: { community_name: "Kolekto FC", member_code: "KFC/001" },
    })!;
    assert.ok(result.text.includes("Kolekto FC"));
    assert.ok(result.text.includes("KFC/001"));
    assert.ok(result.text.includes("added to"));
  });

  it("officer_term.end text contains role and community", () => {
    const result = renderTemplate({
      eventType: "officer_term.end",
      payload: { community_name: "Board", officer_role: "treasurer" },
    })!;
    assert.ok(result.text.includes("Board"));
    assert.ok(result.text.includes("treasurer"));
    assert.ok(result.text.includes("ended"));
  });

  it("every template produces a non-empty text alternative", () => {
    const events: EventContext[] = [
      { eventType: "member.create", payload: { community_name: "C", member_code: "C/1" } },
      { eventType: "member.approve_join", payload: { community_name: "C", member_code: "C/2" } },
      { eventType: "officer_invitation.accept", payload: { community_name: "C", officer_role: "admin" } },
      { eventType: "officer_term.end", payload: { community_name: "C", officer_role: "admin" } },
    ];
    for (const ctx of events) {
      const result = renderTemplate(ctx);
      assert.ok(result, `template exists for ${ctx.eventType}`);
      assert.ok(result.text.trim().length > 0, `text is non-empty for ${ctx.eventType}`);
    }
  });
});

// ── HTML escaping — adversarial community names ─────────────────────────────

describe("HTML escaping — community names", () => {
  it("escapes <script>alert(1)</script>", () => {
    const result = renderTemplate({
      eventType: "member.create",
      payload: { community_name: '<script>alert(1)</script>', member_code: "X/1" },
    })!;
    assert.ok(!result.html.includes("<script>"), "no raw script tag in HTML");
    assert.ok(result.html.includes("&lt;script&gt;"), "script tag is escaped");
  });

  it("escapes <img src=x onerror=alert(1)>", () => {
    const result = renderTemplate({
      eventType: "member.create",
      payload: { community_name: '<img src=x onerror=alert(1)>', member_code: "X/2" },
    })!;
    assert.ok(!result.html.includes("<img"), "no raw img tag in HTML");
    assert.ok(result.html.includes("&lt;img"), "img tag is escaped");
  });

  it('escapes "\'><svg onload=alert(1)>', () => {
    const xss = '"\'><svg onload=alert(1)>';
    const result = renderTemplate({
      eventType: "officer_invitation.accept",
      payload: { community_name: xss, officer_role: "admin" },
    })!;
    assert.ok(!result.html.includes("<svg"), "no raw svg tag in HTML");
    assert.ok(result.html.includes("&lt;svg"), "svg tag is escaped");
    assert.ok(result.html.includes("&quot;"), "quotes are escaped");
    assert.ok(result.html.includes("&#39;"), "apostrophes are escaped");
  });
});

// ── HTML escaping — member names containing HTML ────────────────────────────

describe("HTML escaping — member codes with HTML", () => {
  it("escapes HTML in member_code", () => {
    const result = renderTemplate({
      eventType: "member.create",
      payload: { community_name: "Safe", member_code: '<b>BOLD</b>' },
    })!;
    assert.ok(!result.html.includes("<b>BOLD</b>"), "no raw bold tag");
    assert.ok(result.html.includes("&lt;b&gt;"), "bold tag is escaped");
  });
});

// ── Quotes and apostrophes ──────────────────────────────────────────────────

describe("HTML escaping — quotes and apostrophes", () => {
  it("handles names with quotes safely", () => {
    const result = renderTemplate({
      eventType: "member.create",
      payload: { community_name: "O'Brien's \"Club\"", member_code: "OB/1" },
    })!;
    assert.ok(result.html.includes("&#39;"), "apostrophe is escaped");
    assert.ok(result.html.includes("&quot;"), "quote is escaped");
    assert.ok(result.text.includes("O'Brien's \"Club\""), "plain text preserves original");
  });
});

// ── Newlines cannot manipulate structure ────────────────────────────────────

describe("newline handling", () => {
  it("newlines in community name do not break HTML structure", () => {
    const result = renderTemplate({
      eventType: "member.create",
      payload: { community_name: "Line1\nLine2\rLine3", member_code: "X/1" },
    })!;
    assert.ok(result.html.includes("Line1\nLine2\rLine3") || result.html.includes("Line1"), "content is present");
    assert.ok(!result.html.includes("</td>Line"), "no structural break");
  });
});

// ── Long names ──────────────────────────────────────────────────────────────

describe("long user-provided names", () => {
  it("renders without error for a very long community name", () => {
    const longName = "A".repeat(500);
    const result = renderTemplate({
      eventType: "member.create",
      payload: { community_name: longName, member_code: "X/1" },
    });
    assert.ok(result, "template renders");
    assert.ok(result.html.length > 0, "HTML is non-empty");
    assert.ok(result.text.length > 0, "text is non-empty");
  });

  it("renders without error for a very long officer role", () => {
    const longRole = "R".repeat(200);
    const result = renderTemplate({
      eventType: "officer_invitation.accept",
      payload: { community_name: "C", officer_role: longRole },
    });
    assert.ok(result, "template renders");
  });
});

// ── Empty or missing optional values ────────────────────────────────────────

describe("empty or missing values", () => {
  it("handles missing community_name gracefully", () => {
    const result = renderTemplate({
      eventType: "member.create",
      payload: { member_code: "X/1" },
    })!;
    assert.ok(result.subject.length > 0, "subject is non-empty");
    assert.ok(result.text.includes("your community"), "fallback text used");
  });

  it("handles missing member_code gracefully", () => {
    const result = renderTemplate({
      eventType: "member.create",
      payload: { community_name: "Test" },
    })!;
    assert.ok(!result.text.includes("member ID is:"), "no code line when code is absent");
    assert.ok(!result.html.includes("member ID:"), "no code block in HTML when code is absent");
  });

  it("handles missing officer_role gracefully", () => {
    const result = renderTemplate({
      eventType: "officer_invitation.accept",
      payload: { community_name: "Board" },
    })!;
    assert.ok(result.subject.includes("officer"), "falls back to generic role");
  });

  it("handles completely empty payload", () => {
    const result = renderTemplate({
      eventType: "member.create",
      payload: {},
    })!;
    assert.ok(result.subject.length > 0);
    assert.ok(result.text.length > 0);
    assert.ok(result.html.length > 0);
  });
});

// ── Unverified contact safety ───────────────────────────────────────────────

describe("content safety — no forbidden PII", () => {
  it("membership confirmation never claims the address is verified", () => {
    const result = renderTemplate({
      eventType: "member.create",
      payload: { community_name: "Test", member_code: "T/1" },
    })!;
    const combined = result.text + result.html;
    assert.ok(!combined.toLowerCase().includes("verified email"), "no claim of verified email");
    assert.ok(!combined.toLowerCase().includes("your email is verified"), "no verification claim");
  });

  it("no template contains recipient addresses in the body", () => {
    const events: EventContext[] = [
      { eventType: "member.create", payload: { community_name: "C", member_code: "C/1" } },
      { eventType: "member.approve_join", payload: { community_name: "C", member_code: "C/1" } },
      { eventType: "officer_invitation.accept", payload: { community_name: "C", officer_role: "admin" } },
      { eventType: "officer_term.end", payload: { community_name: "C", officer_role: "admin" } },
    ];
    for (const ctx of events) {
      const msg = buildTemplatedMessage("secret@example.com", ctx);
      assert.ok(!msg.text.includes("secret@example.com"), `address not in text for ${ctx.eventType}`);
      assert.ok(!(msg.html ?? "").includes("secret@example.com"), `address not in html for ${ctx.eventType}`);
    }
  });

  it("internal IDs never appear in rendered output", () => {
    const internalId = "a4000000-0000-4000-8000-000000000001";
    const result = renderTemplate({
      eventType: "member.create",
      payload: { community_name: "Test", member_code: "T/1", community_id: internalId },
    })!;
    assert.ok(!result.html.includes(internalId), "no internal UUID in HTML");
    assert.ok(!result.text.includes(internalId), "no internal UUID in text");
  });
});

// ── Plain-text adversarial input safety ─────────────────────────────────────

describe("plain-text adversarial safety", () => {
  it("script tags appear as literal text, not markup", () => {
    const result = renderTemplate({
      eventType: "member.create",
      payload: { community_name: '<script>alert(1)</script>', member_code: "X/1" },
    })!;
    assert.ok(result.text.includes('<script>alert(1)</script>'), "script tag is literal in text");
  });

  it("img onerror appears as literal text", () => {
    const result = renderTemplate({
      eventType: "officer_term.end",
      payload: { community_name: '<img src=x onerror=alert(1)>', officer_role: "admin" },
    })!;
    assert.ok(result.text.includes('<img src=x onerror=alert(1)>'), "img tag is literal in text");
  });
});

// ── buildEmailMessage integration ───────────────────────────────────────────

describe("buildEmailMessage", () => {
  it("uses templates when event context is provided", () => {
    const msg = buildEmailMessage("test@example.com", {
      eventType: "member.create",
      payload: { community_name: "FC", member_code: "FC/1" },
    });
    assert.equal(msg.to, "test@example.com");
    assert.ok(msg.subject.includes("FC"), "subject uses template");
    assert.ok(msg.html !== undefined, "HTML is present");
  });

  it("falls back to placeholder when context is null", () => {
    const msg = buildEmailMessage("test@example.com", null);
    assert.equal(msg.subject, "You have a new Kolekto notification");
    assert.equal(msg.html, undefined, "no HTML in placeholder");
  });

  it("falls back to placeholder for unknown event types", () => {
    const msg = buildEmailMessage("test@example.com", {
      eventType: "collection.publish",
      payload: {},
    });
    assert.equal(msg.subject, "You have a new Kolekto notification");
  });
});

// ── Every templated message passes assertValidEmailRequest ──────────────────

describe("email request validation", () => {
  const events: EventContext[] = [
    { eventType: "member.create", payload: { community_name: "Community", member_code: "C/001" } },
    { eventType: "member.approve_join", payload: { community_name: "Group", member_code: "G/042" } },
    { eventType: "officer_invitation.accept", payload: { community_name: "Council", officer_role: "treasurer" } },
    { eventType: "officer_term.end", payload: { community_name: "Board", officer_role: "admin" } },
  ];

  for (const ctx of events) {
    it(`${ctx.eventType}: passes adapter validation`, () => {
      const msg = buildTemplatedMessage("valid@example.com", ctx);
      assert.doesNotThrow(() => {
        assertValidEmailRequest({ idempotencyKey: "test-key-001", message: msg });
      });
    });
  }

  it("placeholder message passes validation", () => {
    const msg = buildPlaceholderMessage("valid@example.com");
    assert.doesNotThrow(() => {
      assertValidEmailRequest({ idempotencyKey: "test-key-002", message: msg });
    });
  });

  it("adversarial-name template passes validation", () => {
    const msg = buildTemplatedMessage("valid@example.com", {
      eventType: "member.create",
      payload: { community_name: '<script>alert("xss")</script>', member_code: "<b>X</b>" },
    });
    assert.doesNotThrow(() => {
      assertValidEmailRequest({ idempotencyKey: "test-key-003", message: msg });
    });
  });
});

// ── Existing sender test behaviour is unchanged ─────────────────────────────

describe("placeholder message backward compatibility", () => {
  it("placeholder has no HTML part", () => {
    const msg = buildPlaceholderMessage("a@b.com");
    assert.equal(msg.html, undefined);
  });

  it("placeholder subject is unchanged", () => {
    const msg = buildPlaceholderMessage("a@b.com");
    assert.equal(msg.subject, "You have a new Kolekto notification");
  });

  it("placeholder puts address only in to, never in body", () => {
    const msg = buildPlaceholderMessage("secret@test.com");
    assert.ok(!msg.text.includes("secret@test.com"));
  });
});
