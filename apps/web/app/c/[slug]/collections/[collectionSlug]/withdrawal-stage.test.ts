import { describe, expect, it } from "vitest";
import { withdrawalCodePhase, withdrawalStageLabel } from "./money-view.ts";

// The member's code screen must never spin for ever, and must not say "sent"
// before the email provider accepted the message.
describe("withdrawalCodePhase", () => {
  const created = Date.parse("2026-11-20T09:00:00Z");
  const otp = (status: string, expiresAt: string | null = null) => ({
    status,
    expiresAt,
    resendAvailableAt: new Date(created + 60_000).toISOString(),
  });

  it("shows sending (and polls) for the first minute only", () => {
    expect(withdrawalCodePhase(otp("pending_delivery"), created + 5_000)).toEqual({ phase: "sending", canEnterCode: false, keepPolling: true });
    expect(withdrawalCodePhase(otp("pending_delivery"), created + 61_000).phase).toBe("stalled");
  });

  it("stops polling once an unsent code would have lapsed", () => {
    expect(withdrawalCodePhase(otp("pending_delivery"), created + 11 * 60_000)).toEqual({ phase: "stalled", canEnterCode: false, keepPolling: false });
  });

  it("does not say sent while the worker is still sending an issued code", () => {
    const issued = otp("sending", new Date(created + 10 * 60_000).toISOString());
    expect(withdrawalCodePhase(issued, created + 3_000)).toMatchObject({ phase: "sending", canEnterCode: false });
    // Delivery never confirmed: the email may have gone out, so entering stays possible.
    expect(withdrawalCodePhase(issued, created + 90_000)).toMatchObject({ phase: "stalled", canEnterCode: true });
  });

  it("lets the member enter a sent code until it expires", () => {
    const sent = otp("sent", new Date(created + 10 * 60_000).toISOString());
    expect(withdrawalCodePhase(sent, created + 30_000)).toEqual({ phase: "sent", canEnterCode: true, keepPolling: false });
    expect(withdrawalCodePhase(sent, created + 10 * 60_000).phase).toBe("expired");
  });

  it("maps terminal states without polling", () => {
    for (const [status, phase] of [
      ["delivery_failed", "delivery_failed"],
      ["expired", "expired"],
      ["locked", "locked"],
      ["superseded", "closed"],
      ["cancelled", "closed"],
    ] as const) {
      expect(withdrawalCodePhase(otp(status), created + 5_000)).toEqual({ phase, canEnterCode: false, keepPolling: false });
    }
    expect(withdrawalCodePhase(null, created).phase).toBe("loading");
  });
});

// Owner decisions 2026-11-19: the member's code, then the owner's approval,
// are two separate waits; neither is payment.
describe("withdrawalStageLabel", () => {
  it("names each wait in the two-approval flow", () => {
    expect(withdrawalStageLabel("awaiting_member_verification", "requested").label).toBe("Waiting for the requester's code");
    expect(withdrawalStageLabel("awaiting_owner_approval", "requested").label).toBe("Waiting for administrator review");
    expect(withdrawalStageLabel("ready_for_transfer", "approved").label).toBe("Approved — queued for transfer");
  });

  it("falls back to the status label for every other stage", () => {
    for (const status of ["processing", "paid", "failed", "rejected", "cancelled", "reversed"] as const) {
      expect(withdrawalStageLabel(status, status).label).not.toMatch(/code|administrator review|owner approval|queued/);
    }
  });
});
