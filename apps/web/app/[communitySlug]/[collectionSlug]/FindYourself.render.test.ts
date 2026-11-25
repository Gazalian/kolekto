import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The component imports the "use server" module; nothing here may reach a database.
const serverActions = vi.hoisted(() => ({
  validateMembershipIdAction: vi.fn(),
  membershipPassSummaryAction: vi.fn(),
  confirmMembershipPassAction: vi.fn(),
  rejectMembershipPassAction: vi.fn(),
}));
vi.mock("./actions.ts", () => serverActions);

const { ConfirmMemberDetails, FindYourself, MembershipIdEntry } = await import("./FindYourself.tsx");
const { INVALID_MEMBERSHIP_ID_MESSAGE } = await import("./membership-id-flow.ts");

const noop = () => undefined;
/** The boolean attribute, not the `disabled:` Tailwind variants in the class list. */
const DISABLED_ATTR = /\sdisabled=""/;

function entry(props: Partial<Parameters<typeof MembershipIdEntry>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(MembershipIdEntry, {
      value: "",
      error: null,
      pending: false,
      organiser: "Ikorodu Development Society",
      onChange: noop,
      onSubmit: noop,
      ...props,
    }),
  );
}

function submitButton(html: string): string {
  return html.match(/<button[^>]*type="submit"[^>]*>.*?<\/button>/s)?.[0] ?? "";
}

function input(html: string): string {
  return html.match(/<input[^>]*>/)?.[0] ?? "";
}

describe("Screen 1 — membership ID entry", () => {
  it("renders the heading, guidance and a labelled input", () => {
    const html = entry();
    expect(html).toContain("Identify yourself");
    expect(html).toContain("Enter your community membership ID to continue with your contribution.");
    const id = input(html).match(/id="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`for="${id}"`);
    expect(html).toMatch(/<label[^>]*>Membership ID/);
    expect(input(html)).toContain('autoCapitalize="characters"');
    expect(input(html)).toContain('autoComplete="off"');
  });

  it("is the first screen a managed collection shows", () => {
    const html = renderToStaticMarkup(
      createElement(FindYourself, {
        communitySlug: "ids",
        collectionSlug: "dues",
        organiser: "IDS",
        onIdentified: noop,
      }),
    );
    expect(html).toContain("Identify yourself");
    expect(html).not.toContain("Are these your details?");
    expect(serverActions.validateMembershipIdAction).not.toHaveBeenCalled();
  });

  it("disables Continue until a full-length ID is typed", () => {
    expect(submitButton(entry({ value: "" }))).toMatch(DISABLED_ATTR);
    expect(submitButton(entry({ value: "AB/12" }))).toMatch(DISABLED_ATTR);
    expect(submitButton(entry({ value: "IDS/K7P9Q" }))).not.toMatch(DISABLED_ATTR);
  });

  it("shows a loading state that blocks a second submission", () => {
    const html = entry({ value: "IDS/K7P9Q", pending: true });
    const button = submitButton(html);
    expect(button).toMatch(DISABLED_ATTR);
    expect(button).toContain('aria-busy="true"');
    expect(button).toContain("Checking…");
    expect(input(html)).toContain("readOnly");
  });

  it("shows the generic invalid-ID message as an alert tied to the input", () => {
    const html = entry({ value: "IDS/K7P9Q", error: INVALID_MEMBERSHIP_ID_MESSAGE });
    expect(html).toContain(
      "We couldn&#x27;t find a member with this ID. Please check and try again.",
    );
    expect(html).toMatch(/role="alert"/);
    expect(input(html)).toContain('aria-invalid="true"');
  });
});

describe("Screen 2 — confirm member details", () => {
  const summary = { fullName: "Aisha Ibrahim", emailMasked: "a•••@gmail.com", phoneMasked: "+234 ••• ••• •567" };

  function confirmScreen(props: Partial<Parameters<typeof ConfirmMemberDetails>[0]> = {}): string {
    return renderToStaticMarkup(
      createElement(ConfirmMemberDetails, { summary, pending: false, onConfirm: noop, onReject: noop, ...props }),
    );
  }

  it("shows the full name, masked email and masked phone, and asks the question", () => {
    const html = confirmScreen();
    expect(html).toContain("Are these your details?");
    expect(html).toContain("Aisha Ibrahim");
    expect(html).toContain("a•••@gmail.com");
    expect(html).toContain("+234 ••• ••• •567");
  });

  it("offers Yes, continue and No, that's not me", () => {
    const html = confirmScreen();
    expect(html).toMatch(/<button[^>]*>Yes, continue<\/button>/);
    expect(html).toMatch(/<button[^>]*>No, that&#x27;s not me<\/button>/);
  });

  it("disables both answers while a request is in flight", () => {
    const buttons = confirmScreen({ pending: true }).match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button).toMatch(DISABLED_ATTR);
  });

  it("says when a contact detail is not on record instead of leaving a gap", () => {
    const html = confirmScreen({ summary: { fullName: "Bola", emailMasked: null, phoneMasked: null } });
    expect(html.match(/Not on record/g)).toHaveLength(2);
  });
});

describe("what the browser bundle can reach", () => {
  const source = readFileSync(new URL("./FindYourself.tsx", import.meta.url), "utf8");
  const flow = readFileSync(new URL("./membership-id-flow.ts", import.meta.url), "utf8");

  it("uses only the A2.4 membership pass actions", () => {
    expect(source).not.toMatch(/findMemberAction|findCollectionMember|confirmMemberAction/);
    for (const action of [
      "validateMembershipIdAction",
      "membershipPassSummaryAction",
      "confirmMembershipPassAction",
      "rejectMembershipPassAction",
    ]) {
      expect(source).toContain(action);
    }
  });

  it("never stores identity in the browser or puts it in a URL", () => {
    for (const text of [source, flow]) {
      expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|history\.(push|replace)State|searchParams|console\./);
      expect(text).not.toMatch(/accessToken|access_token|memberId|member_id/);
    }
  });
});
