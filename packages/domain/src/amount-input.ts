/**
 * amount-input.ts — what an amount FIELD holds while somebody is typing in it.
 *
 * Text in, text out. Nothing here converts to kobo or does arithmetic on
 * money: `fromNaira` (money.ts) remains the only parser, and the server
 * re-validates whatever a field sends (ADR 0003). These functions only decide
 * how the digits a person typed are shown, and where their cursor goes.
 *
 * Two forms:
 *
 *   canonical  "1234567.5"   what form state holds and what is sent to the server
 *   display    "1,234,567.5" what the person sees in the field
 *
 * The canonical form is digits, an optional ".", and at most two decimals. It
 * keeps a trailing "." so that typing "12." on the way to "12.50" is possible.
 */

/** The most whole-naira digits a field accepts (₦999 trillion). Keeps the canonical form inside the schema's 20-character limit. */
export const AMOUNT_MAX_WHOLE_DIGITS = 15;

/**
 * "5k" → "5000", "1.5k" → "1500", "₦2.5K" → "2500".
 *
 * `fromNaira` and the validation schema both accept the shorthand, so a field
 * that simply dropped the "k" would turn ₦5,000 into ₦5. Expanding it is done
 * by moving the decimal point in the text, never by floating-point
 * multiplication.
 */
function expandThousandsShorthand(input: string): string | null {
  const compact = input.replace(/[₦\s,]/g, "");
  const match = /^(\d*)(?:\.(\d*))?k$/i.exec(compact);
  if (!match) return null;
  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  if (whole === "" && fraction === "") return null;

  const shifted = whole + fraction.slice(0, 3).padEnd(3, "0");
  const remainder = fraction.slice(3, 5);
  return canonicalAmount(remainder ? `${shifted}.${remainder}` : shifted);
}

/** Reduces anything typed or pasted to the canonical form. Never throws. */
export function canonicalAmount(input: string): string {
  const expanded = expandThousandsShorthand(input);
  if (expanded !== null) return expanded;

  let whole = "";
  let fraction = "";
  let seenPoint = false;

  for (const character of input) {
    if (character >= "0" && character <= "9") {
      if (!seenPoint) whole += character;
      else if (fraction.length < 2) fraction += character;
    } else if (character === "." && !seenPoint) {
      seenPoint = true;
    }
    // Everything else — "₦", spaces, separators, letters, "-" — is not part
    // of an amount and is dropped.
  }

  whole = whole.replace(/^0+(?=\d)/, "");
  if (seenPoint && whole === "") whole = "0";
  return seenPoint ? `${whole}.${fraction}` : whole;
}

/** Canonical (or anything) → what the field shows: "1234567.5" → "1,234,567.5". */
export function formatAmountDisplay(value: string): string {
  const canonical = canonicalAmount(value);
  if (canonical === "") return "";
  const [whole = "", fraction] = canonical.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** Whole-naira digits in a canonical value — what `AMOUNT_MAX_WHOLE_DIGITS` limits. */
export function amountWholeDigits(value: string): number {
  return (canonicalAmount(value).split(".")[0] ?? "").length;
}

/**
 * One edit to an amount field: the raw text the browser now holds and where
 * its cursor is, in; the canonical value, the formatted text and the cursor's
 * new position, out.
 *
 * The cursor is placed by counting the digits (and ".") to its left before
 * formatting, and putting it after the same number of them afterwards. That is
 * what keeps it beside the digit just typed when a separator appears or
 * disappears elsewhere in the number.
 */
export function formatAmountInput(
  raw: string,
  caret: number,
): { value: string; display: string; caret: number } {
  const value = canonicalAmount(raw);
  const display = formatAmountDisplay(value);

  if (expandThousandsShorthand(raw) !== null) {
    return { value, display, caret: display.length };
  }

  const significantBefore = canonicalAmount(raw.slice(0, Math.max(0, caret))).length;
  return { value, display, caret: caretAfterSignificant(display, significantBefore) };
}

function caretAfterSignificant(display: string, count: number): number {
  if (count <= 0) return 0;
  let seen = 0;
  for (let index = 0; index < display.length; index += 1) {
    if (display[index] !== ",") seen += 1;
    if (seen === count) return index + 1;
  }
  return display.length;
}

/**
 * Kobo from the database back into the text an amount field holds, without
 * losing the kobo: 500050 → "5000.50", 500000 → "5000". Truncating here would
 * make a form that reduces an amount every time it is opened and saved.
 */
export function nairaInputFromKobo(value: bigint | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const total = BigInt(value);
  const negative = total < 0n;
  const absolute = negative ? -total : total;
  const whole = absolute / 100n;
  const remainder = absolute % 100n;
  const text = remainder === 0n ? whole.toString() : `${whole}.${remainder.toString().padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}
