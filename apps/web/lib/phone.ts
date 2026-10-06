/**
 * Client-side phone normalization matching the DB's app.normalise_phone().
 * Nigeria-first: 0803…, 234803…, +234803… all normalize to +234803….
 */
export function normalizePhone(raw: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^0-9+]/g, "");

  if (digits.startsWith("+") && /^\+[1-9][0-9]{7,15}$/.test(digits)) {
    return digits;
  }

  // 0803… (11 digits with trunk prefix)
  if (/^0[789][01][0-9]{8}$/.test(digits)) {
    return "+234" + digits.slice(1);
  }
  // 234803… (13 digits, country code without +)
  if (/^234[789][01][0-9]{8}$/.test(digits)) {
    return "+" + digits;
  }
  // 803… (10 digits, no trunk prefix)
  if (/^[789][01][0-9]{8}$/.test(digits)) {
    return "+234" + digits;
  }

  return null;
}
