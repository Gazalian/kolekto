import { describe, expect, it } from "vitest";
import {
  PANEL_MARGIN,
  PANEL_MIN_HEIGHT,
  PANEL_WIDTH_DESKTOP,
  PANEL_WIDTH_MOBILE,
  computePanelCoords,
  type ButtonRect,
} from "./notification-panel-placement.ts";

/**
 * Unit tests for the panel-placement math.
 *
 * The real bug was easy to see and hard to describe in a Playwright
 * assertion: the sidebar bell sat at the bottom-left of the viewport and the
 * old `absolute right-0 top-full` sent the panel ~140px off the left and past
 * the bottom. These tests pin the per-quadrant placement so a future refactor
 * cannot silently regress it.
 */

function rect(top: number, left: number, w: number, h: number): ButtonRect {
  return { top, left, right: left + w, bottom: top + h };
}

describe("computePanelCoords", () => {
  it("desktop sidebar bell at bottom-left: panel stays on screen and flips above the button", () => {
    // Reproduction coordinates captured against the running app: button 34x34
    // at (12, 677) in a 1024x768 viewport. Without the fix the panel rendered
    // at x=-141, bottom off-screen.
    const coords = computePanelCoords(rect(677, 12, 34, 34), 1024, 768);

    expect(coords.width).toBe(PANEL_WIDTH_DESKTOP);
    expect(coords.left).toBeGreaterThanOrEqual(PANEL_MARGIN);
    expect(coords.left + coords.width).toBeLessThanOrEqual(1024 - PANEL_MARGIN);
    // The button bottom (711) leaves only 57px below — not enough — so the
    // panel must open above the button (top strictly less than button.top).
    expect(coords.top).toBeLessThan(677);
    expect(coords.top).toBeGreaterThanOrEqual(PANEL_MARGIN);
    expect(coords.top + coords.maxHeight).toBeLessThanOrEqual(768);
  });

  it("mobile header bell at top-right: panel sits below and stays inside the viewport", () => {
    // 375x812 phone viewport, bell at (330, 15) 32x32.
    const coords = computePanelCoords(rect(15, 330, 32, 32), 375, 812);

    expect(coords.width).toBe(PANEL_WIDTH_MOBILE);
    expect(coords.left).toBeGreaterThanOrEqual(PANEL_MARGIN);
    expect(coords.left + coords.width).toBeLessThanOrEqual(375 - PANEL_MARGIN);
    // Opens below the button.
    expect(coords.top).toBeGreaterThan(15 + 32);
    expect(coords.top).toBeLessThan(812);
  });

  it("desktop top-right bell (AuthenticatedTopBar): opens below, flipped to right-aligned", () => {
    // AuthenticatedTopBar on a 1024-wide viewport: bell near (975, 15) 34x34.
    // 975 + 384 = 1359 > 1016 → cannot left-align, must flip to right-aligned.
    const coords = computePanelCoords(rect(15, 975, 34, 34), 1024, 768);

    expect(coords.width).toBe(PANEL_WIDTH_DESKTOP);
    expect(coords.left + coords.width).toBeLessThanOrEqual(1024 - PANEL_MARGIN);
    expect(coords.left).toBeGreaterThanOrEqual(PANEL_MARGIN);
    // Opens below the button bottom (49).
    expect(coords.top).toBeGreaterThan(49);
  });

  it("short viewport: clamps vertically so the panel is at least PANEL_MIN_HEIGHT tall", () => {
    const coords = computePanelCoords(rect(200, 50, 32, 32), 320, 400);
    expect(coords.maxHeight).toBeGreaterThanOrEqual(PANEL_MIN_HEIGHT);
    expect(coords.top).toBeGreaterThanOrEqual(PANEL_MARGIN);
    expect(coords.top + coords.maxHeight).toBeLessThanOrEqual(400);
  });

  it("prefers opening below when there is enough space, even if above has more", () => {
    const coords = computePanelCoords(rect(50, 100, 32, 32), 1024, 1000);
    expect(coords.top).toBeGreaterThan(50 + 32);
  });

  it("button near the right edge in a mobile viewport: panel right-aligns and stays on-screen", () => {
    // 390x844 phone, bell at (350, 10) 32x32 — like the mobile top-bar case.
    const coords = computePanelCoords(rect(10, 350, 32, 32), 390, 844);
    expect(coords.width).toBe(PANEL_WIDTH_MOBILE);
    expect(coords.left).toBeGreaterThanOrEqual(PANEL_MARGIN);
    expect(coords.left + coords.width).toBeLessThanOrEqual(390 - PANEL_MARGIN);
  });
});
