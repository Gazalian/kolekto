"use server";

import { fromNaira } from "@kolekto/domain";
import {
  assignObligations,
  cancelObligation,
  createCollection,
  DatabaseError,
  deleteDraftCollection,
  exemptObligation,
  openCollectionCycle,
  setCollectionAudience,
  setCollectionCover,
  setCollectionEvent,
  setCollectionFields,
  setCollectionItems,
  setCollectionRecurrence,
  setCollectionStory,
  setCollectionSuggestedAmounts,
  setCollectionTiers,
  syncCollectionObligations,
  setItemHidden,
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
  setCollectionAudienceSchema,
  setCollectionEventSchema,
  setCollectionFieldsSchema,
  setCollectionItemsSchema,
  setCollectionRecurrenceSchema,
  setCollectionStorySchema,
  setCollectionSuggestedAmountsSchema,
  setCollectionTiersSchema,
  syncObligationsSchema,
  transitionCollectionStatusSchema,
  updateCollectionSchema,
  updateObligationAmountSchema,
  waiveObligationSchema,
} from "@kolekto/validation";
import { revalidatePath } from "next/cache";
import { requireCallerContext } from "../../../../lib/caller.ts";
import { removeCollectionCover, uploadCollectionCover } from "../../../../lib/collection-cover.ts";
import { removeItemImage, uploadItemImage } from "../../../../lib/item-image.ts";
import { getCommunityAccess, hasPermission } from "../../../../lib/permissions.ts";
import { createClient } from "../../../../lib/supabase/server.ts";

export interface ActionResult {
  error?: string;
  ok?: boolean;
  /**
   * For the writes that replace a whole list (tiers, items): the ids the rows
   * now hold, in display order. The creation wizard saves a step each time it
   * is completed, and a row sent with no id is a new row — so the client
   * carries these back into its drafts to keep identity stable across saves
   * (ADR 0010).
   */
  savedIds?: string[];
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
  // The ids the rows now hold, in display order. The wizard saves a step
  // every time it is completed (M7.5 part A), and a payload with no id makes
  // a NEW row — so without reading these back, editing an option twice would
  // give it two different identities. ADR 0010: identity is the id.
  return { ok: true, savedIds: await readRowIds("collection_tiers", parsed.data.collectionId) };
}

/** Ids of a collection's tiers or items, in the order a contributor sees them. RLS scopes the read to communities the caller holds a role in. */
async function readRowIds(table: "collection_tiers" | "collection_items", collectionId: string): Promise<string[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from(table)
    .select("id")
    .eq("collection_id", collectionId)
    .order("sort_order")
    .order("name");
  return (data ?? []).map((row) => row.id as string);
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

// ── Type-specific configuration (§26–§32) ───────────────────────────────────
//
// One action per collection type rather than one that takes a blob. Each maps
// to the write function that knows that type's rules, so an item collection
// cannot be given a recurrence and a fixed collection cannot be given items.

export async function setCollectionItemsAction(
  slug: string,
  collectionSlug: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = setCollectionItemsSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the items and try again" };

  const caller = await requireCallerContext();
  try {
    await setCollectionItems(caller, {
      collectionId: parsed.data.collectionId,
      items: parsed.data.items.map((item, index) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        priceKobo: fromNaira(item.price),
        quantityAvailable: item.quantityAvailable,
        maxPerOrder: item.maxPerOrder,
        // Was dropped here, which is why an uploaded item image never
        // survived the save that followed it: the editor produced the URL,
        // the schema carried it, the write function accepted it, and this
        // mapping quietly left it out.
        imageUrl: item.imageUrl,
        sortOrder: item.sortOrder ?? index,
      })),
    });
  } catch (error) {
    return { error: messageFrom(error, "Could not save the items") };
  }
  revalidateCollection(slug, collectionSlug);
  return { ok: true, savedIds: await readRowIds("collection_items", parsed.data.collectionId) };
}

export async function setItemHiddenAction(
  slug: string,
  collectionSlug: string,
  itemId: string,
  hidden: boolean,
): Promise<ActionResult> {
  const caller = await requireCallerContext();
  try {
    await setItemHidden(caller, itemId, hidden);
  } catch (error) {
    return { error: messageFrom(error, "Could not change the item") };
  }
  revalidateCollection(slug, collectionSlug);
  return { ok: true };
}

export async function setCollectionEventAction(
  slug: string,
  collectionSlug: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = setCollectionEventSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the event details and try again" };

  const caller = await requireCallerContext();
  try {
    await setCollectionEvent(caller, {
      collectionId: parsed.data.collectionId,
      eventStartsAt: parsed.data.eventStartsAt,
      eventEndsAt: parsed.data.eventEndsAt,
      venue: parsed.data.venue,
      collectAttendeeDetails: parsed.data.collectAttendeeDetails,
    });
  } catch (error) {
    return { error: messageFrom(error, "Could not save the event details") };
  }
  revalidateCollection(slug, collectionSlug);
  return { ok: true };
}

export async function setCollectionSuggestedAmountsAction(
  slug: string,
  collectionSlug: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = setCollectionSuggestedAmountsSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the suggested amounts" };

  const caller = await requireCallerContext();
  try {
    await setCollectionSuggestedAmounts(caller, {
      collectionId: parsed.data.collectionId,
      amountsKobo: parsed.data.amounts.map((amount) => fromNaira(amount)),
    });
  } catch (error) {
    return { error: messageFrom(error, "Could not save the suggested amounts") };
  }
  revalidateCollection(slug, collectionSlug);
  return { ok: true };
}

// ── A fundraiser's story (§5/§19) ────────────────────────────────────────────

export async function setCollectionStoryAction(
  slug: string,
  collectionSlug: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = setCollectionStorySchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the story and try again" };

  const caller = await requireCallerContext();
  try {
    await setCollectionStory(caller, parsed.data);
  } catch (error) {
    return { error: messageFrom(error, "Could not save the story") };
  }
  revalidateCollection(slug, collectionSlug);
  return { ok: true };
}

export async function setCollectionRecurrenceAction(
  slug: string,
  collectionSlug: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = setCollectionRecurrenceSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the schedule and try again" };

  const caller = await requireCallerContext();
  try {
    await setCollectionRecurrence(caller, {
      collectionId: parsed.data.collectionId,
      frequency: parsed.data.frequency,
      intervalCount: parsed.data.intervalCount,
      startsOn: parsed.data.startsOn,
      dueAfterDays: parsed.data.dueAfterDays,
    });
  } catch (error) {
    return { error: messageFrom(error, "Could not save the schedule") };
  }
  revalidateCollection(slug, collectionSlug);
  return { ok: true };
}

/**
 * Opens the next period of a recurring collection.
 *
 * Opening a period creates nothing on its own — obligations still come from a
 * separate, deliberate sync (§38). This only says the period exists.
 */
export async function openCollectionCycleAction(
  slug: string,
  collectionSlug: string,
  collectionId: string,
): Promise<ActionResult & { cycleKey?: string }> {
  const caller = await requireCallerContext();
  try {
    const cycle = await openCollectionCycle(caller, collectionId);
    revalidateCollection(slug, collectionSlug);
    return { ok: true, cycleKey: cycle.cycle_key };
  } catch (error) {
    return { error: messageFrom(error, "Could not open the next period") };
  }
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

// ── Flyer (§33) ─────────────────────────────────────────────────────────────
//
// The bucket grants no client role any write, so these two actions are the only
// way an image gets in or out. Authorisation happens here, against the same
// permission every other collection edit checks — the storage layer deliberately
// knows nothing about who may touch which collection.

async function assertMayEditCollection(collectionId: string): Promise<{ communityId: string } | { error: string }> {
  const supabase = await createClient();

  // RLS already limits this read to collections in communities the caller holds
  // a role in, so a collection id from elsewhere resolves to nothing.
  const { data } = await supabase
    .from("collections")
    .select("community_id, status")
    .eq("id", collectionId)
    .maybeSingle();

  if (!data) return { error: "That collection could not be found" };

  const access = await getCommunityAccess(data.community_id as string);
  if (!hasPermission(access, "collection.draft")) {
    return { error: "You do not have permission to change this collection" };
  }
  if (["closed", "archived", "suspended"].includes(data.status as string)) {
    return { error: `A ${data.status} collection cannot be edited` };
  }

  return { communityId: data.community_id as string };
}

export async function uploadCoverAction(
  slug: string,
  collectionSlug: string,
  collectionId: string,
  formData: FormData,
): Promise<ActionResult & { url?: string }> {
  const permitted = await assertMayEditCollection(collectionId);
  if ("error" in permitted) return { error: permitted.error };

  const file = formData.get("cover");
  if (!(file instanceof File)) return { error: "Choose an image to upload" };

  const uploaded = await uploadCollectionCover(permitted.communityId, collectionId, file);
  if (uploaded.error || !uploaded.url) return { error: uploaded.error ?? "The image could not be uploaded" };

  const caller = await requireCallerContext();
  try {
    await setCollectionCover(caller, { collectionId, coverImageUrl: uploaded.url });
  } catch (error) {
    // The object is already in the bucket and now belongs to nothing, so it is
    // taken back out. Leaving it would be storage nobody can see or delete.
    await removeCollectionCover(permitted.communityId, collectionId, uploaded.url);
    return { error: messageFrom(error, "The image was uploaded but could not be attached") };
  }

  revalidateCollection(slug, collectionSlug);
  return { ok: true, url: uploaded.url };
}

export async function removeCoverAction(
  slug: string,
  collectionSlug: string,
  collectionId: string,
  url: string,
): Promise<ActionResult> {
  const permitted = await assertMayEditCollection(collectionId);
  if ("error" in permitted) return { error: permitted.error };

  const caller = await requireCallerContext();
  try {
    await setCollectionCover(caller, { collectionId, coverImageUrl: undefined });
  } catch (error) {
    return { error: messageFrom(error, "Could not remove the image") };
  }

  // The row is cleared first: an object left in the bucket is wasted storage,
  // while a row pointing at a deleted object is a broken page.
  const removed = await removeCollectionCover(permitted.communityId, collectionId, url);
  if (removed.error) return { error: removed.error };

  revalidateCollection(slug, collectionSlug);
  return { ok: true };
}

// ── Item images (§4/§16/§21) ─────────────────────────────────────────────────
//
// Same shape as the flyer actions just above: the browser holds no storage
// credential, `assertMayEditCollection` is the one gate, and a failed attach
// takes the object back out rather than leaving orphaned storage.

export async function uploadItemImageAction(
  slug: string,
  collectionSlug: string,
  collectionId: string,
  formData: FormData,
): Promise<ActionResult & { url?: string }> {
  const permitted = await assertMayEditCollection(collectionId);
  if ("error" in permitted) return { error: permitted.error };

  const file = formData.get("image");
  if (!(file instanceof File)) return { error: "Choose an image to upload" };

  const uploaded = await uploadItemImage(permitted.communityId, collectionId, file);
  if (uploaded.error || !uploaded.url) return { error: uploaded.error ?? "The image could not be uploaded" };

  // Unlike the flyer, an item image is not attached by its own write function
  // — it travels with the rest of that item's fields the next time the item
  // list is saved (setCollectionItemsAction). This call only produces the URL.
  return { ok: true, url: uploaded.url };
}

export async function removeItemImageAction(collectionId: string, url: string): Promise<ActionResult> {
  const permitted = await assertMayEditCollection(collectionId);
  if ("error" in permitted) return { error: permitted.error };

  const removed = await removeItemImage(permitted.communityId, collectionId, url);
  if (removed.error) return { error: removed.error };
  return { ok: true };
}

// ── Audience ────────────────────────────────────────────────────────────────

export async function setCollectionAudienceAction(
  slug: string,
  collectionSlug: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = setCollectionAudienceSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Choose who this collection is for" };

  const caller = await requireCallerContext();
  try {
    await setCollectionAudience(caller, parsed.data);
  } catch (error) {
    return { error: messageFrom(error, "Could not save who this collection is for") };
  }
  revalidateCollection(slug, collectionSlug);
  return { ok: true };
}

/**
 * Materialises obligations for members who are eligible and have none.
 *
 * Deliberately an action someone takes, never a trigger: a member joining a
 * group must not acquire a debt on their own, and this is the button that
 * decides otherwise. It never removes an obligation.
 */
export async function syncObligationsAction(
  slug: string,
  collectionSlug: string,
  input: unknown,
): Promise<ActionResult & { created?: number }> {
  const parsed = syncObligationsSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Could not add these obligations" };

  const caller = await requireCallerContext();
  try {
    const created = await syncCollectionObligations(caller, {
      collectionId: parsed.data.collectionId,
      expectedAmountKobo: toKobo(parsed.data.expectedAmount),
      dueAt: parsed.data.dueAt,
      cycleKey: parsed.data.cycleKey,
    });
    revalidateCollection(slug, collectionSlug);
    return { ok: true, created };
  } catch (error) {
    return { error: messageFrom(error, "Could not add these obligations") };
  }
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
      cycleKey: parsed.data.cycleKey,
      tierId: parsed.data.tierId,
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
