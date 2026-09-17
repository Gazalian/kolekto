/**
 * money.ts — the only place in Kolekto where a monetary value is manipulated.
 *
 * ADR 0003. Every amount is a whole number of kobo, held as a `bigint`.
 *
 * WHY NOT `number`. The previous engine's primitive was:
 *
 *     roundCurrency(v) => Number((Number(v) || 0).toFixed(2))
 *
 * which made money an IEEE-754 double. Two things went wrong, and both are
 * worth remembering because they are subtle enough to be reintroduced by
 * someone acting reasonably.
 *
 *   1. `toFixed` is not half-up. `(1.005).toFixed(2)` is `"1.00"`, because 1.005
 *      is not representable in binary and the nearest double is slightly below
 *      it. Fee calculations at kobo boundaries therefore rounded down
 *      unpredictably — not by a rule anyone wrote, but by the accident of
 *      binary representation.
 *   2. Summing a collection's whole history in floating point accumulates
 *      error. Production measured ₦3.59 of unexplainable difference between
 *      `sum(wallets.net_payment)` and `sum(contributions.amount)`, against a
 *      stated tolerance of zero kobo.
 *
 * A `bigint` has neither failure mode. Integers are exact, addition is
 * associative, and rounding happens exactly once, where a rate is applied,
 * under a rule stated in code and pinned by golden vectors.
 *
 * RATES ARE BASIS POINTS. A percentage is an integer too: 0.5% is 50 bps,
 * 1.5% is 150 bps. There is no float anywhere in this file, including in the
 * rates, because a float rate multiplied by an integer amount reintroduces
 * exactly the problem the integer amount was meant to solve.
 */

/** A whole number of kobo. 100 kobo = ₦1. Branded so it cannot be confused with a plain bigint, a naira value, or a count. */
export type Kobo = bigint & { readonly __kobo: unique symbol };

/** A rate in basis points. 100 bps = 1%. Always an integer. */
export type BasisPoints = number & { readonly __bps: unique symbol };

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/** Construct kobo from a bigint, an integer number, or a digit string. Rejects anything fractional. */
export function kobo(value: bigint | number | string): Kobo {
  if (typeof value === "bigint") return value as Kobo;

  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new MoneyError(
        `kobo() received the non-integer ${value}. A fraction of a kobo is not money — ` +
          `use fromNaira() if you meant a naira amount, or round explicitly before converting.`,
      );
    }
    if (!Number.isSafeInteger(value)) {
      throw new MoneyError(`kobo() received ${value}, which is outside the safe integer range. Pass a bigint.`);
    }
    return BigInt(value) as Kobo;
  }

  if (!/^-?\d+$/.test(value.trim())) {
    throw new MoneyError(`kobo() received ${JSON.stringify(value)}, which is not a whole number of kobo.`);
  }
  return BigInt(value.trim()) as Kobo;
}

export const ZERO: Kobo = 0n as Kobo;

/**
 * Parse a naira amount into kobo.
 *
 * Accepts what a Nigerian user actually types (UX-07): `20000`, `20,000`,
 * `20k`, `₦20,000.50`. Rejects more than two decimal places rather than
 * silently rounding — a third decimal in a money field means the input is
 * wrong, and the person should be told, not guessed at.
 */
export function fromNaira(input: string | number): Kobo {
  const raw = String(input).trim().replace(/[₦\s,]/g, "");
  if (raw === "") throw new MoneyError("fromNaira() received an empty value.");

  const shorthand = /^(-?\d+(?:\.\d+)?)k$/i.exec(raw);
  const normalised = shorthand ? String(Number(shorthand[1]) * 1000) : raw;

  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(normalised);
  if (!match) {
    throw new MoneyError(
      `fromNaira() could not read ${JSON.stringify(String(input))}. ` +
        `Expected an amount in naira with at most two decimal places.`,
    );
  }

  const [, sign, whole, fraction = ""] = match;
  const padded = (fraction + "00").slice(0, 2);
  const magnitude = BigInt(whole!) * 100n + BigInt(padded);
  return (sign === "-" ? -magnitude : magnitude) as Kobo;
}

/** Format kobo as naira for display. Humans only — never parse this back. */
export function formatNaira(value: Kobo, options: { symbol?: boolean; decimals?: boolean } = {}): string {
  const { symbol = true, decimals = true } = options;
  const negative = value < ZERO;
  const absolute = negative ? -value : value;

  const whole = absolute / 100n;
  const remainder = absolute % 100n;

  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = decimals || remainder !== 0n ? `.${remainder.toString().padStart(2, "0")}` : "";

  return `${negative ? "-" : ""}${symbol ? "₦" : ""}${grouped}${fraction}`;
}

/** Serialise kobo for a JSON boundary. A string, never a JSON number — `JSON.stringify` cannot represent a bigint, and a number would silently lose precision above 2^53. */
export function toJSON(value: Kobo): string {
  return value.toString();
}

export const add = (a: Kobo, b: Kobo): Kobo => (a + b) as Kobo;
export const subtract = (a: Kobo, b: Kobo): Kobo => (a - b) as Kobo;
export const multiply = (a: Kobo, factor: bigint): Kobo => (a * factor) as Kobo;
export const negate = (a: Kobo): Kobo => -a as Kobo;
export const abs = (a: Kobo): Kobo => (a < ZERO ? -a : a) as Kobo;
export const min = (a: Kobo, b: Kobo): Kobo => (a < b ? a : b);
export const max = (a: Kobo, b: Kobo): Kobo => (a > b ? a : b);
export const sum = (values: readonly Kobo[]): Kobo => values.reduce(add, ZERO);
export const isZero = (a: Kobo): boolean => a === ZERO;
export const isPositive = (a: Kobo): boolean => a > ZERO;

/** Clamp to a range. Used for minimum and maximum contribution amounts. */
export function clamp(value: Kobo, lower: Kobo, upper: Kobo): Kobo {
  if (lower > upper) throw new MoneyError("clamp() called with lower above upper.");
  return min(max(value, lower), upper);
}

/** Construct a basis-points rate. Integer only, 0 to 10,000 (0% to 100%). */
export function bps(value: number): BasisPoints {
  if (!Number.isInteger(value)) {
    throw new MoneyError(
      `bps() received ${value}. A rate is an integer number of basis points — 0.5% is bps(50), not bps(0.005).`,
    );
  }
  if (value < 0 || value > 10_000) {
    throw new MoneyError(`bps() received ${value}, outside the range 0 to 10000.`);
  }
  return value as BasisPoints;
}

const BPS_DIVISOR = 10_000n;

/**
 * Apply a rate, rounding half away from zero.
 *
 * Half away from zero, not banker's rounding and not `toFixed`'s accident: a
 * fee of exactly half a kobo rounds up, symmetrically for negatives. The rule
 * is stated here, applied in exactly one place, and pinned by golden vectors,
 * which is the whole argument for this module existing.
 *
 * FIN-09 requires the rule to be documented in the fee engine and on receipts.
 * This is the documentation.
 */
export function applyRate(amount: Kobo, rate: BasisPoints): Kobo {
  const negative = amount < ZERO;
  const magnitude = negative ? -amount : amount;

  const product = magnitude * BigInt(rate);
  const quotient = product / BPS_DIVISOR;
  const remainder = product % BPS_DIVISOR;

  const rounded = remainder * 2n >= BPS_DIVISOR ? quotient + 1n : quotient;
  return (negative ? -rounded : rounded) as Kobo;
}

/**
 * Split an amount into `parts` shares that sum exactly to the original.
 *
 * The remainder is distributed one kobo at a time to the earliest shares, so
 * nothing is created or lost. COL-12 needs this — one contributor paying for
 * several members — and so does allocating a withdrawal across collections
 * (WDR-06). The naive `amount / parts` loses kobo, and lost kobo is exactly
 * what a zero-tolerance reconciliation (RCN-01) reports at 3am.
 */
export function allocate(amount: Kobo, parts: number): Kobo[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new MoneyError(`allocate() needs a positive integer number of parts, received ${parts}.`);
  }

  const divisor = BigInt(parts);
  const base = amount / divisor;
  const remainder = amount % divisor;
  const step = remainder < 0n ? -1n : 1n;
  let left = remainder < 0n ? -remainder : remainder;

  return Array.from({ length: parts }, () => {
    if (left > 0n) {
      left -= 1n;
      return (base + step) as Kobo;
    }
    return base as Kobo;
  });
}

/**
 * Split by weights, preserving the total exactly.
 *
 * Largest-remainder apportionment: floor every share, then hand the leftover
 * kobo to the shares with the largest discarded fractions. Used to allocate a
 * withdrawal across the collections it covers (WDR-06).
 */
export function allocateByWeights(amount: Kobo, weights: readonly bigint[]): Kobo[] {
  if (weights.length === 0) throw new MoneyError("allocateByWeights() received no weights.");
  if (weights.some((w) => w < 0n)) throw new MoneyError("allocateByWeights() received a negative weight.");

  const total = weights.reduce((a, b) => a + b, 0n);
  if (total === 0n) return allocate(amount, weights.length);

  const shares = weights.map((w) => (amount * w) / total);
  const remainders = weights.map((w, i) => ({ index: i, remainder: (amount * w) % total }));

  let distributed = shares.reduce((a, b) => a + b, 0n);
  let leftover = amount - distributed;
  const step = leftover < 0n ? -1n : 1n;

  remainders.sort((a, b) => (b.remainder === a.remainder ? a.index - b.index : b.remainder > a.remainder ? 1 : -1));

  let cursor = 0;
  while (leftover !== 0n && cursor < remainders.length) {
    shares[remainders[cursor]!.index] = shares[remainders[cursor]!.index]! + step;
    leftover -= step;
    cursor += 1;
  }

  return shares as Kobo[];
}
