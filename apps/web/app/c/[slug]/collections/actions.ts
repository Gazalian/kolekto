"use server";

import { fromNaira } from "@kolekto/domain";
import {
  assignObligations,
  cancelObligation,
  createCollection,
  DatabaseError,
  deleteDraftCollection,
  exemptObligation,
  setCollectionFields,
  setCollectionTiers,
  setTierHidden,
  transitionCollectionStatus,
  updateCollection,
  updateObligationAmount,
  waiveObligationAmount,
} from "@kolekto/db";
import {
  assignObligationsSchema,
  cancelObligationSchema,
  createCollectionSchema,
  exemptObligationSchema,
  setCollectionFieldsSchema,
  setCollectionTiersSchema,
  transitionCollectionStatusSchema,
  updateCollectionSchema,
  updateObligationAmountSchema,
  waiveObligationSchema,
} from "@kolekto/validation";
import { revalidatePath } from "next/cache";
import { requireCallerContext } from "../../../../lib/caller.ts";
import { createClient } from "../../../../lib/supabase/server.ts";

export interface ActionResult {
  error?: string;
  ok?: boolean;
}

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof DatabaseError ? error.message : fallback;
}

/**
 * Naira text to kobo, in the one module allowed to do it (ADR 0003). Returns
 * `undefined` for an absent amount so an optional field stays optional rather
 * than becoming a zero someone later treats as a price.
 */
function toKobo(value: string | undefined): bigint | undefined {
  return value ? fromNaira(value) : undefined;
}

function revalidateCollection(slug: string, collectionSlug?: string): void {
  revalidatePath(`/c/${slug}/collections`);
  if (collectionSlug) revalidatePath(`/c/${slug}/collections/${collectionSlug}`);
}

export async function createCollectionAction(
  slug: string,
  input: unknown,
): Promise<ActionResult & { collectionId?: string; collectionSlug?: string | undefined }> {
  const parsed = createCollectionSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form and try again" };

  const caller = await requireCallerContext();
  const data = parsed.data;

  try {
    const collectionId = await createCollection(caller, {
      communityId: data.communityId,
      name: data.name,
      category: data.category,
      description: data.description,
      participationMode: data.participationMode,
      amountModel: data.amountModel,
      paymentPlan: data.paymentPlan,
      schedule: data.schedule,
      fixedAmountKobo: toKobo(data.fixedAmount),
      minAmountKobo: toKobo(data.minAmount),
      maxAmountKobo: toKobo(data.maxAmount),
      targetAmountKobo: toKobo(data.targetAmount),
      startsAt: data.startsAt,
      deadlineAt: data.deadlineAt,
      visibility: data.visibility,
      allowNonMembers: data.allowNonMembers,
      allowAnonymous: data.allowAnonymous,
      thankYouMessage: data.thankYouMessage,
    });

    // The slug is allocated by the database (it deduplicates within the
    // community), so the only way to know where the new collection lives is to
    // read it back. RLS scopes the read to this caller as usual.
    const supabase = await createClient();
    const { data: created } = await supabase.from("collections").select("slug").eq("id", collectionId).maybeSingle();

    revalidateCollection(slug);
    return { ok: true, collectionId, collectionSlug: created?.slug as string | undefined };
  } catch (error) {
    return { error: messageFrom(error, "Could not create the collection") };
  }
}

export async function updateCollectionAction(
  slug: string,
  collectionSlug: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = updateCollectionSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form and try again" };

  const caller = await requireCallerContext();
  const data = parsed.data;

  try {
    await updateCollection(caller, {
      collectionId: data.collectionId,
      name: data.name,
      category: data.category,
      description: data.description,
      amountModel: data.amountModel,
      participationMode: data.participationMode,
      paymentPlan: data.paymentPlan,
      fixedAmountKobo: toKobo(data.fixedAmount),
      minAmountKobo: toKobo(data.minAmount),
      maxAmountKobo: toKobo(data.maxAmount),
      targetAmountKobo: toKobo(data.targetAmount),
      startsAt: data.startsAt,
      deadlineAt: data.deadlineAt,
      visibility: data.visibility,
      allowNonMembers: data.allowNonMembers,
      allowAnonymous: data.allowAnonymous,
      thankYouMessage: data.thankYouMessage,
    });
  } catch (error) {
    return { error: messageFrom(error, "Could not save the collection") };
  }
  revalidateCollection(slug, collectionSlug);
  return { ok: true };
}

export async function setCollectionTiersAction(
  slug: string,
  collectionSlug: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = setCollectionTiersSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the options and try again" };

  const caller = await requireCallerContext();
  try {
    await setCollectionTiers(caller, {
      collectionId: parsed.data.collectionId,
      tiers: parsed.data.tiers.map((tier, index) => ({
        id: tier.id,
        name: tier.name,
        description: tier.description,
        priceKobo: fromNaira(tier.price),
        quantityLimit: tier.quantityLimit,
        perOrderLimit: tier.perOrderLimit,
        codePrefix: tier.codePrefix?.toUpperCase(),
        sortOrder: tier.sortOrder ?? index,
      })),
    });
  } catch (error) {
    return { error: messageFrom(error, "Could not save the options") };
  }
  revalidateCollection(slug, collectionSlug);
  return { ok: true };
}

export async function setTierHiddenAction(
  slug: string,
  collectionSlug: string,
  tierId: string,
  hidden: boolean,
): Promise<ActionResult> {
  const caller = await requireCallerContext();
  try {
    await setTierHidden(caller, tierId, hidden);
  } catch (error) {
    return { error: messageFrom(error, "Could not change the option") };
  }
  revalidateCollection(slug, collectionSlug);
  return { ok: true };
}

export async function setCollectionFieldsAction(
  slug: string,
  collectionSlug: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = setCollectionFieldsSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the questions and try again" };

  const caller = await requireCallerContext();
  try {
    await setCollectionFields(caller, {
      collectionId: parsed.data.collectionId,
      fields: parsed.data.fields.map((field, index) => ({
        key: field.key,
        label: field.label,
        type: field.type,
        options: field.options,
        required: field.required,
        sortOrder: field.sortOrder ?? index,
      })),
    });
  } catch (error) {
    return { error: messageFrom(error, "Could not save the questions") };
  }
  revalidateCollection(slug, collectionSlug);
  return { ok: true };
}

/** STM-01: `expected` is what the screen last saw. The database refuses the call if the collection has moved on since. */
export async function transitionCollectionStatusAction(
  slug: string,
  collectionSlug: string,
  input: unknown,
): Promise<ActionResult & { status?: string }> {
  const parsed = transitionCollectionStatusSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That change is not available" };

  const caller = await requireCallerContext();
  try {
    const status = await transitionCollectionStatus(caller, parsed.data);
    revalidateCollection(slug, collectionSlug);
    return { ok: true, status };
  } catch (error) {
    return { error: messageFrom(error, "Could not change the collection's status") };
  }
}

export async function deleteDraftCollectionAction(slug: string, collectionId: string): Promise<ActionResult> {
  const caller = await requireCallerContext();
  try {
    await deleteDraftCollection(caller, collectionId);
  } catch (error) {
    return { error: messageFrom(error, "Could not discard the draft") };
  }
  revalidateCollection(slug);
  return { ok: true };
}

// ── Obligations ─────────────────────────────────────────────────────────────

export async function assignObligationsAction(
  slug: string,
  collectionSlug: string,
  input: unknown,
): Promise<ActionResult & { created?: number }> {
  const parsed = assignObligationsSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Select who is expected to pay" };

  const caller = await requireCallerContext();
  try {
    const created = await assignObligations(caller, {
      collectionId: parsed.data.collectionId,
      memberIds: parsed.data.memberIds,
      expectedAmountKobo: toKobo(parsed.data.expectedAmount),
      dueAt: parsed.data.dueAt,
    });
    revalidateCollection(slug, collectionSlug);
    return { ok: true, created };
  } catch (error) {
    return { error: messageFrom(error, "Could not assign these members") };
  }
}

export async function updateObligationAmountAction(
  slug: string,
  collectionSlug: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = updateObligationAmountSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Enter an amount" };

  const caller = await requireCallerContext();
  try {
    await updateObligationAmount(caller, {
      obligationId: parsed.data.obligationId,
      expectedAmountKobo: fromNaira(parsed.data.expectedAmount),
    });
  } catch (error) {
    return { error: messageFrom(error, "Could not change the amount") };
  }
  revalidateCollection(slug, collectionSlug);
  return { ok: true };
}

export async function exemptObligationAction(
  slug: string,
  collectionSlug: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = exemptObligationSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Give a reason" };

  const caller = await requireCallerContext();
  try {
    await exemptObligation(caller, parsed.data);
  } catch (error) {
    return { error: messageFrom(error, "Could not exempt this member") };
  }
  revalidateCollection(slug, collectionSlug);
  return { ok: true };
}

export async function waiveObligationAction(
  slug: string,
  collectionSlug: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = waiveObligationSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Enter an amount and a reason" };

  const caller = await requireCallerContext();
  try {
    await waiveObligationAmount(caller, {
      obligationId: parsed.data.obligationId,
      waivedAmountKobo: fromNaira(parsed.data.waivedAmount),
      reason: parsed.data.reason,
    });
  } catch (error) {
    return { error: messageFrom(error, "Could not waive this amount") };
  }
  revalidateCollection(slug, collectionSlug);
  return { ok: true };
}

export async function cancelObligationAction(
  slug: string,
  collectionSlug: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = cancelObligationSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Could not cancel this" };

  const caller = await requireCallerContext();
  try {
    await cancelObligation(caller, parsed.data);
  } catch (error) {
    return { error: messageFrom(error, "Could not cancel this obligation") };
  }
  revalidateCollection(slug, collectionSlug);
  return { ok: true };
}
