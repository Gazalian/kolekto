/**
 * Legacy naira → integer kobo. Exact per D2 evidence — no legacy value has
 * more than 2 decimal places, none is negative. `round(v * 100)` is exact.
 *
 * String path taken deliberately: numeric.toString() on Postgres returns a
 * decimal string, never scientific, and integer arithmetic on that string is
 * exact where `Number(v) * 100` is not for values like 46069689.35.
 */
export function nairaToKobo(value: string | number | null | undefined): bigint | null {
  if (value == null) return null;
  const s = typeof value === "number" ? value.toString() : String(value).trim();
  if (s === "") return null;
  const negative = s.startsWith("-");
  const body = negative ? s.slice(1) : s;
  if (!/^\d+(\.\d+)?$/.test(body)) throw new Error(`nairaToKobo: not a decimal number: ${JSON.stringify(value)}`);
  const [whole, frac = ""] = body.split(".");
  if (frac.length > 2) throw new Error(`nairaToKobo: more than 2 decimal places: ${JSON.stringify(value)}`);
  const padded = (frac + "00").slice(0, 2);
  const total = BigInt(whole) * 100n + BigInt(padded);
  const signed = negative ? -total : total;
  if (signed < 0n) throw new Error(`nairaToKobo: negative not allowed: ${JSON.stringify(value)}`);
  return signed;
}
