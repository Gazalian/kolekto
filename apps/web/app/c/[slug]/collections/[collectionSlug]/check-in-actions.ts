"use server";

import { checkInObligation, checkOutObligation, DatabaseError } from "@kolekto/db";
import { revalidatePath } from "next/cache";
import { requireCallerContext } from "../../../../../lib/caller.ts";

/**
 * The door (M7.5 part E).
 *
 * Both actions pass an obligation id and nothing else. Everything that
 * decides anything — which community it belongs to, whether the caller may
 * work that door, whether the person is already inside — is decided by the
 * database function, from the row. An obligation id from another community
 * fails the permission check inside it rather than being filtered here
 * (SEC-18: a client-supplied id never implies eligibility).
 */

export interface CheckInResult {
  error?: string;
  ok?: boolean;
}

export async function checkInAction(slug: string, collectionSlug: string, obligationId: string): Promise<CheckInResult> {
  const caller = await requireCallerContext();
  try {
    await checkInObligation(caller, obligationId);
  } catch (error) {
    return { error: error instanceof DatabaseError ? error.message : "That person could not be checked in" };
  }
  revalidatePath(`/c/${slug}/collections/${collectionSlug}`);
  return { ok: true };
}

export async function checkOutAction(
  slug: string,
  collectionSlug: string,
  obligationId: string,
): Promise<CheckInResult> {
  const caller = await requireCallerContext();
  try {
    await checkOutObligation(caller, obligationId);
  } catch (error) {
    return { error: error instanceof DatabaseError ? error.message : "That person could not be checked out" };
  }
  revalidatePath(`/c/${slug}/collections/${collectionSlug}`);
  return { ok: true };
}
