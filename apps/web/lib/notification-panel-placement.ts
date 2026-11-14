/**
 * notification-panel-placement.ts — pure placement math for `NotificationBell`.
 *
 * Lives apart from the component so it can be unit-tested without a browser
 * (vitest's include glob only reaches `lib/**` and `app/**`).
 *
 * The job: given the bell button's viewport-rect and the current viewport
 * size, pick a `position: fixed` origin for the panel that keeps every edge
 * on screen. The previous `absolute right-0 top-full` placement broke the
 * sidebar bell (bottom-left of the viewport), which sent the panel ~140px off
 * the left and past the bottom (QA LAYOUT-1).
 */

/** Width classes on NotificationPanel: `w-80` (mobile) and `sm:w-96` (sm+). */
export const PANEL_WIDTH_MOBILE = 320;
export const PANEL_WIDTH_DESKTOP = 384;
/** `max-h-96` list plus header/footer; a generous estimate for first paint. */
export const PANEL_ESTIMATED_HEIGHT = 440;
export const PANEL_MARGIN = 8;
export const PANEL_GAP = 4;
export const PANEL_MIN_HEIGHT = 160;
/** Tailwind's `sm:` breakpoint — matches `NotificationPanel`'s `sm:w-96`. */
const SM_BREAKPOINT = 640;

export interface ButtonRect {
  readonly top: number;
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
}

export interface PanelCoords {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly maxHeight: number;
}

export function computePanelCoords(buttonRect: ButtonRect, viewportWidth: number, viewportHeight: number): PanelCoords {
  const width = viewportWidth >= SM_BREAKPOINT ? PANEL_WIDTH_DESKTOP : PANEL_WIDTH_MOBILE;

  // Prefer left-aligning the panel with the button; flip to right-aligned if
  // left-aligned would run off the right edge. Clamp into the viewport either
  // way so a button near either edge still produces an on-screen panel.
  let left: number;
  if (buttonRect.left + width <= viewportWidth - PANEL_MARGIN) {
    left = buttonRect.left;
  } else {
    left = buttonRect.right - width;
  }
  left = Math.max(PANEL_MARGIN, Math.min(left, viewportWidth - width - PANEL_MARGIN));

  // Prefer opening below the button; flip above only when below cannot fit the
  // estimated height AND above has more room. If neither direction has enough
  // room, clamp into view and let the panel's own scroller handle the rest.
  const spaceBelow = viewportHeight - buttonRect.bottom - PANEL_GAP - PANEL_MARGIN;
  const spaceAbove = buttonRect.top - PANEL_GAP - PANEL_MARGIN;
  let top: number;
  let maxHeight: number;
  if (spaceBelow >= PANEL_ESTIMATED_HEIGHT || spaceBelow >= spaceAbove) {
    top = buttonRect.bottom + PANEL_GAP;
    maxHeight = Math.max(PANEL_MIN_HEIGHT, spaceBelow);
    // Clamp top so a cramped viewport still produces on-screen coordinates;
    // the panel's inner scroller handles the overflow.
    if (top + maxHeight > viewportHeight - PANEL_MARGIN) {
      top = Math.max(PANEL_MARGIN, viewportHeight - maxHeight - PANEL_MARGIN);
    }
  } else {
    // Open above the button: cap height at the estimated panel size so it
    // sits in [top, top + maxHeight], both of which must stay above the
    // button to avoid overlap and off-screen clipping.
    maxHeight = Math.min(Math.max(PANEL_MIN_HEIGHT, spaceAbove), PANEL_ESTIMATED_HEIGHT);
    top = Math.max(PANEL_MARGIN, buttonRect.top - PANEL_GAP - maxHeight);
  }

  return { top, left, width, maxHeight };
}
