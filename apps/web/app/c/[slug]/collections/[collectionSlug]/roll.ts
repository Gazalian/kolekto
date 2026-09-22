import type { Obligation } from "@kolekto/db";

/**
 * The roll's shapes and sizes, as data rather than as behaviour.
 *
 * Separate from `roll-actions.ts` because that file is `"use server"`, and a
 * server-action module may only export async functions. A plain constant or a
 * type alias there fails the production build rather than the typecheck —
 * which is how it got past the first check in M7.5, and why it is not being
 * done a second time.
 */

export type RollFilter = "all" | "outstanding" | "exempt";

export interface RollRow {
  obligation: Obligation;
  memberName: string;
  memberIdentifier: string | null;
  reference: string | null;
  tierName: string | null;
}

export interface RollCounts {
  all: number;
  outstanding: number;
  exempt: number;
}

export interface RollPage {
  error?: string;
  rows?: RollRow[];
  /** How many rows the current filter has in total. Absent on a search, which is capped rather than counted. */
  total?: number;
  counts?: RollCounts;
  /** True when this is a capped search result rather than a page of the roll. */
  searched?: boolean;
}

/** How many rows a page of the roll holds. */
export const ROLL_PAGE_SIZE = 50;

/** How many answers a search gives back. Past fifty, an operator has mistyped rather than found somebody. */
export const ROLL_MATCH_LIMIT = 50;

/** How big a first page the door gets before it starts asking the server. */
export const DOOR_PAGE_SIZE = 100;
