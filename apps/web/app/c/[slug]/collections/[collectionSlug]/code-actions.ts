"use server";

import {
  DatabaseError,
  issueContributorReferencesForCollection,
  setCollectionCodeSettings,
} from "@kolekto/db";
import { isValidCollectionPrefix } from "@kolekto/domain";
import { revalidatePath } from "next/cache";
import { requireCallerContext } from "../../../../../lib/caller.ts";

/**
 * Configuring and issuing contributor references (M7.6 parts I, J, N).
 *
 * Both pass a collection id and nothing that decides anything. Which
 * community it belongs to, whether the caller may configure the format,
 * whether the format is still changeable — all decided by the database
 * function, from the row (ADR 0008, SEC-18). The checks here exist to give a
 * person a sentence they can act on before the round trip, not to be the
 * control.
 */

export interface CodeSettingsResult {
  error?: string;
  ok?: boolean;
}

export async function saveCodeSettingsAction(
  slug: string,
  collectionSlug: string,
  input: {
    collectionId: string;
    enabled: boolean;
    prefix: string | null;
    separator: string;
    digits: number;
    startNumber: number;
    style: "sequential" | "random";
  },
): Promise<CodeSettingsResult> {
  if (input.enabled && (!input.prefix || !isValidCollectionPrefix(input.prefix))) {
    return {
      error: "A reference needs a prefix of 2 to 10 letters or digits — a bare number is not recognisable on a receipt",
    };
  }
  if (input.digits < 1 || input.digits > 8) {
    return { error: "A reference can be padded to between 1 and 8 digits" };
  }
  if (input.startNumber < 1) {
    return { error: "Numbering starts at 1 or higher" };
  }

  const caller = await requireCallerContext();
  try {
    await setCollectionCodeSettings(caller, input);
  } catch (error) {
    return { error: error instanceof DatabaseError ? error.message : "That could not be saved" };
  }

  revalidatePath(`/c/${slug}/collections/${collectionSlug}`);
  return { ok: true };
}

export async function issueAllReferencesAction(
  slug: string,
  collectionSlug: string,
  collectionId: string,
): Promise<{ error?: string; issued?: number }> {
  const caller = await requireCallerContext();
  try {
    const issued = await issueContributorReferencesForCollection(caller, collectionId);
    revalidatePath(`/c/${slug}/collections/${collectionSlug}`);
    return { issued };
  } catch (error) {
    return { error: error instanceof DatabaseError ? error.message : "References could not be issued" };
  }
}
