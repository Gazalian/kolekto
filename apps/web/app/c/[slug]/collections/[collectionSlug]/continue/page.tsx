import type {
  Collection,
  CollectionCodeSettings,
  CollectionField,
  CollectionItem,
  CollectionRecurrence,
  CollectionTier,
  Community,
  MemberGroup,
} from "@kolekto/db";
import { notFound, redirect } from "next/navigation";
import { getCommunityAccess, hasPermission } from "../../../../../../lib/permissions.ts";
import { createClient } from "../../../../../../lib/supabase/server.ts";
import { NewCollectionForm, type ExistingDraft } from "../../new/NewCollectionForm.tsx";
import { emptyCodes } from "../../new/codeDefaults.ts";
import { flowKeyFor } from "../../new/flows.ts";

export const metadata = { title: "Continue draft" };

/**
 * Picking a draft back up (M7.6 part A4).
 *
 * "A host should be able to start creating a collection, close the browser,
 * return later, and continue from substantially the same point without losing
 * completed work."
 *
 * There is no saved wizard state anywhere, and there should not be: the draft
 * IS the state. Every step of the wizard writes real rows — the collection,
 * its options, its items, its event, its audience, its questions — so
 * reopening it is a matter of reading those rows back and handing them to the
 * same form. The only thing that could not be derived from them is which step
 * the organiser had reached, which is why `collections.draft_step` exists.
 *
 * WHICH FLOW. The wizard's flows are presets over the configuration axes, not
 * a column (there is no collection_type — ADR 0013). Reopening one means
 * finding the preset that matches what the rows say, which is what
 * `flowKeyFor` does. It never GUESSES the collection into a different shape:
 * the fields it restores are the collection's own, and the flow only decides
 * which questions get asked about them, in what order, and in whose words.
 *
 * M7.7 made the flows differ in LENGTH as well as in wording, so `draft_step`
 * is clamped to the flow that is actually being resumed. A nine-step draft
 * cannot land on step 9 of an eight-step flow.
 *
 * Only a draft. A published collection is edited from its Settings tab, where
 * every change is a deliberate one against something people can already see.
 */
export default async function ContinueDraftPage({
  params,
}: {
  params: Promise<{ slug: string; collectionSlug: string }>;
}) {
  const { slug, collectionSlug } = await params;
  const supabase = await createClient();

  const { data: community } = await supabase.from("communities").select("*").eq("slug", slug).maybeSingle();
  if (!community) notFound();
  const c = community as Community;

  const access = await getCommunityAccess(c.id);
  if (!hasPermission(access, "collection.draft")) redirect(`/c/${slug}/collections`);

  // RLS decides whether this caller sees the row at all; a collection in
  // someone else's community resolves to nothing, which is indistinguishable
  // from not existing (SEC-18).
  const { data: row } = await supabase
    .from("collections")
    .select("*")
    .eq("community_id", c.id)
    .eq("slug", collectionSlug)
    .maybeSingle();
  if (!row) notFound();
  const collection = row as Collection;

  if (collection.status !== "draft") redirect(`/c/${slug}/collections/${collectionSlug}`);

  const [
    { data: tiers },
    { data: items },
    { data: fields },
    { data: recurrence },
    { data: audienceGroups },
    { data: groups },
    { count: memberCount },
    { data: codeSettings },
    { count: referencesIssued },
  ] = await Promise.all([
    supabase.from("collection_tiers").select("*").eq("collection_id", collection.id).order("sort_order"),
    supabase.from("collection_items").select("*").eq("collection_id", collection.id).order("sort_order"),
    supabase.from("collection_fields").select("*").eq("collection_id", collection.id).order("sort_order"),
    supabase.from("collection_recurrences").select("*").eq("collection_id", collection.id).maybeSingle(),
    supabase.from("collection_audience_groups").select("group_id").eq("collection_id", collection.id),
    supabase.from("member_groups").select("*").eq("community_id", c.id).is("archived_at", null).order("sort_order"),
    supabase.from("members").select("id", { count: "exact", head: true }).eq("community_id", c.id),
    supabase.from("collection_code_settings").select("*").eq("collection_id", collection.id).maybeSingle(),
    // Whether the format is still the organiser's to change. One issued
    // reference freezes it (CODE-04): it may already be printed on something.
    supabase
      .from("contributor_references")
      .select("id", { count: "exact", head: true })
      .eq("collection_id", collection.id),
  ]);

  const settings = codeSettings as CollectionCodeSettings | null;
  const flowKey = flowKeyFor(collection);

  const existing: ExistingDraft = {
    collectionId: collection.id,
    collectionSlug: collection.slug,
    flowKey,
    step: collection.draft_step,
    name: collection.name,
    description: collection.description ?? "",
    startsAt: toLocalInput(collection.starts_at),
    deadlineAt: toLocalInput(collection.deadline_at),
    amountModel: collection.amount_model as ExistingDraft["amountModel"],
    participationMode: collection.participation_mode as "open" | "managed",
    fixedAmount: toNairaInput(collection.fixed_amount_kobo),
    minAmount: toNairaInput(collection.min_amount_kobo),
    maxAmount: toNairaInput(collection.max_amount_kobo),
    targetAmount: toNairaInput(collection.target_amount_kobo),
    visibility: collection.visibility === "public" ? "public" : "unlisted",
    coverImageUrl: collection.cover_image_url,
    suggestedAmounts: (collection.suggested_amounts_kobo ?? []).map((amount) => toNairaInput(amount)),
    story: {
      what: collection.story_what ?? "",
      why: collection.story_why ?? "",
      impact: collection.story_impact ?? "",
    },
    tiers: ((tiers ?? []) as CollectionTier[]).map((tier) => ({
      id: tier.id,
      name: tier.name,
      description: tier.description ?? "",
      price: toNairaInput(tier.price_kobo),
      quantityLimit: tier.quantity_limit === null ? "" : String(tier.quantity_limit),
      perOrderLimit: tier.per_order_limit === null ? "" : String(tier.per_order_limit),
      codePrefix: tier.code_prefix ?? "",
    })),
    items: ((items ?? []) as CollectionItem[]).map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description ?? "",
      price: toNairaInput(item.price_kobo),
      quantityAvailable: item.quantity_available === null ? "" : String(item.quantity_available),
      maxPerOrder: item.max_per_order === null ? "" : String(item.max_per_order),
      imageUrl: item.image_url ?? undefined,
    })),
    event: {
      startsAt: toLocalInput(collection.event_starts_at),
      endsAt: toLocalInput(collection.event_ends_at),
      venue: collection.venue ?? "",
      collectAttendeeDetails: collection.collect_attendee_details,
    },
    recurrence: recurrence
      ? {
          frequency: (recurrence as CollectionRecurrence).frequency,
          intervalCount: String((recurrence as CollectionRecurrence).interval_count),
          startsOn: (recurrence as CollectionRecurrence).starts_on ?? "",
          dueAfterDays: String((recurrence as CollectionRecurrence).due_after_days),
        }
      : { frequency: "monthly", intervalCount: "1", startsOn: "", dueAfterDays: "0" },
    questions: ((fields ?? []) as CollectionField[]).map((field) => ({
      // The question's own key, which is how the server matches it to the
      // existing row rather than creating a second one.
      key: field.key,
      label: field.label,
      type: field.type as "text" | "number" | "single_select" | "date",
      options: (field.options ?? []).join(", "),
      required: field.required,
    })),
    audienceMode: collection.audience_mode as ExistingDraft["audienceMode"],
    audienceGroupIds: (audienceGroups ?? []).map((group) => group.group_id as string),
    feeMode: collection.fee_mode === "contributor_pays" ? "contributor_pays" : "community_absorbs",
    codes: settings
      ? {
          enabled: collection.codes_enabled,
          prefix: settings.prefix ?? "",
          separator: (settings.separator as ExistingDraft["codes"]["separator"]) ?? "-",
          digits: String(settings.digits),
          startNumber: String(settings.start_number),
          style: settings.style,
        }
      : { ...emptyCodes(), enabled: collection.codes_enabled },
    codesLocked: (referencesIssued ?? 0) > 0,
  };

  return (
    <NewCollectionForm
      slug={slug}
      communityId={c.id}
      memberCount={memberCount ?? 0}
      groups={(groups ?? []) as MemberGroup[]}
      canConfigureCodes={hasPermission(access, "collection.configure_codes")}
      existing={existing}
    />
  );
}

/** Kobo back to what somebody typed. Whole naira, because that is what the field takes. */
function toNairaInput(value: number | null): string {
  if (value === null || value === undefined) return "";
  return String(Math.trunc(value / 100));
}

/** A timestamp back into the value a datetime-local input wants, or a date input for a plain day. */
function toLocalInput(value: string | null): string {
  if (!value) return "";
  return value.slice(0, 16);
}
