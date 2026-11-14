import { fromNaira } from "@kolekto/domain";
import { collectionNameSchema, nairaAmountSchema, type CollectionAudienceMode } from "@kolekto/validation";
import type { Flow, FlowStep, PricedRow, SectionKind } from "./flows.ts";

/**
 * Whether a step may be left, decided before the server is asked.
 *
 * Every rule here restates one the server or the database already enforces
 * (`nairaAmountSchema`, `collectionNameSchema`, the min ≤ max CHECK, unique
 * names per collection). The server stays the authority; this exists so an
 * organiser learns about a problem beside the field, before pressing
 * Continue, instead of from one banner afterwards.
 *
 * Pure, so the same answer drives the Continue button, the field messages and
 * where a resumed draft opens.
 */

export interface WizardSnapshot {
  name: string;
  eventStartsAt: string;
  eventEndsAt: string;
  fixedAmount: string;
  minAmount: string;
  maxAmount: string;
  targetAmount: string;
  suggestedAmounts: readonly string[];
  tiers: readonly PricedRow[];
  items: readonly PricedRow[];
  audienceMode: CollectionAudienceMode;
  audienceGroupIds: readonly string[];
  startsAt: string;
  deadlineAt: string;
  codes: { enabled: boolean; prefix: string };
  canConfigureCodes: boolean;
  codesLocked: boolean;
}

const validAmount = (value: string): boolean => nairaAmountSchema.safeParse(value).success;
const validOptionalAmount = (value: string): boolean => value.trim() === "" || validAmount(value);

/** "Smallest" above "largest" — the message for the largest field, or undefined. */
export function rangeProblem(minAmount: string, maxAmount: string): string | undefined {
  if (!validAmount(minAmount) || !validAmount(maxAmount)) return undefined;
  return fromNaira(minAmount) > fromNaira(maxAmount) ? "Must be at least the smallest amount." : undefined;
}

/** A sales or order window that closes before it opens — the message for the closing field, or undefined. */
export function windowProblem(opens: string, closes: string): string | undefined {
  if (opens.trim() === "" || closes.trim() === "") return undefined;
  return Date.parse(closes) < Date.parse(opens) ? "Must be after it opens." : undefined;
}

/** An event that ends before it starts — the message for the end field, or undefined. */
export function eventEndProblem(startsAt: string, endsAt: string): string | undefined {
  return windowProblem(startsAt, endsAt) ? "Must be after it starts." : undefined;
}

function rowsReady(rows: readonly PricedRow[]): boolean {
  if (rows.length === 0) return false;
  const names = rows.map((row) => row.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) return false;
  return rows.every((row) => row.name.trim() !== "" && validAmount(row.price));
}

export function sectionReady(section: SectionKind, snapshot: WizardSnapshot, flow: Flow): boolean {
  switch (section) {
    case "basics":
    case "story":
      return collectionNameSchema.safeParse(snapshot.name).success;
    case "event":
      return (
        collectionNameSchema.safeParse(snapshot.name).success &&
        snapshot.eventStartsAt.trim() !== "" &&
        !eventEndProblem(snapshot.eventStartsAt, snapshot.eventEndsAt)
      );
    case "amount":
      return validAmount(snapshot.fixedAmount);
    case "openAmount":
      return (
        validOptionalAmount(snapshot.minAmount) &&
        validOptionalAmount(snapshot.maxAmount) &&
        validOptionalAmount(snapshot.targetAmount) &&
        snapshot.suggestedAmounts.every(validOptionalAmount) &&
        !rangeProblem(snapshot.minAmount, snapshot.maxAmount)
      );
    case "goal":
      return (
        validOptionalAmount(snapshot.minAmount) &&
        validOptionalAmount(snapshot.targetAmount) &&
        snapshot.suggestedAmounts.every(validOptionalAmount)
      );
    case "packages":
    case "tickets":
      return rowsReady(snapshot.tiers);
    case "items":
      return rowsReady(snapshot.items);
    case "audience":
      return snapshot.audienceMode !== "groups" || snapshot.audienceGroupIds.length > 0;
    case "timing":
      return (
        (flow.timing !== "sales_window" && flow.timing !== "order_window") ||
        !windowProblem(snapshot.startsAt, snapshot.deadlineAt)
      );
    case "reference":
      return (
        !snapshot.canConfigureCodes ||
        snapshot.codesLocked ||
        !snapshot.codes.enabled ||
        snapshot.codes.prefix.trim().length >= 2
      );
    default:
      return true;
  }
}

export function stepReady(step: FlowStep, snapshot: WizardSnapshot, flow: Flow): boolean {
  return step.sections.every((section) => sectionReady(section, snapshot, flow));
}

/**
 * Where a resumed draft opens: the step it was left on, unless an earlier
 * step still has something required missing.
 *
 * `stored` is `collections.draft_step`, which counts the type picker as 0 and
 * the flow's first step as 1. Drafts saved before the 2026-11 redesign stored
 * positions in longer flows, so the value is clamped first; and because every
 * value is read back from rows, opening on an earlier step than before loses
 * nothing — while opening past an unfinished required step would.
 */
export function resumeStep(flow: Flow, stored: number, snapshot: WizardSnapshot): number {
  const clamped = Math.min(Math.max(stored, 1), flow.steps.length);
  const firstIncomplete = flow.steps.findIndex((step) => !stepReady(step, snapshot, flow));
  return firstIncomplete === -1 ? clamped : Math.min(clamped, firstIncomplete + 1);
}
