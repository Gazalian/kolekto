/**
 * @kolekto/domain — pure domain logic.
 *
 * Rules for this package, enforced by CI (scripts/invariants):
 *   · no I/O. No fetch, no Supabase, no filesystem, no logging.
 *   · no hidden time. `Date.now()` never appears; a caller passes `now`.
 *   · integer kobo only (ADR 0003). No float, no `toFixed`, no `parseFloat`.
 *
 * The shape is inherited from `kolekto-shared-financial`, which was the best
 * engineered artefact in the previous estate: dependency-free, purely
 * functional, and covered by golden vectors with parity harnesses across
 * runtimes. What changed is the number type, which is what was wrong with it.
 */

export * from "./money.ts";
export * from "./fees.ts";
export * from "./settlement.ts";
export * from "./contribution.ts";
export * from "./csv.ts";
export * from "./reference.ts";
export * from "./report.ts";
