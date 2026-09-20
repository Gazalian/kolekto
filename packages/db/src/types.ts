/**
 * types.ts — simplified domain row types for the tables Phase 2 reads and
 * writes.
 *
 * `generated-types.ts` (via `npm run gen-types --workspace packages/db`,
 * i.e. `supabase gen types typescript --local`) is the schema-derived
 * `Database` type and is what `apps/web`'s Supabase client is parameterised
 * with for reads — that one is authoritative for column names and
 * nullability. These types exist alongside it only because
 * `packages/db/src/write.ts` calls `app` schema functions, which return
 * plain result sets `Database` (scoped to `public`, per supabase/config.toml)
 * does not describe. Keep this file limited to what write.ts's signatures
 * need; anything that is just a `public` table read should use `Database`
 * instead of growing a duplicate shape here.
 */

export type OfficerRole = "owner" | "admin" | "treasurer" | "collector" | "viewer";
export type CommunityType =
  | "personal"
  | "university_association"
  | "fellowship"
  | "alumni_association"
  | "cooperative"
  | "estate"
  | "professional_association"
  | "event_committee"
  | "social_group"
  | "school_pta"
  | "community_development"
  | "other";
export type CommunityStatus = "active" | "restricted" | "suspended" | "archived";
export type VerificationStatus = "unverified" | "pending" | "verified" | "rejected" | "expired";
export type MemberStatus = "pending_approval" | "unclaimed" | "invited" | "active" | "archived" | "merged";
export type MemberJoinedVia = "invite_link" | "import" | "manual" | "payment" | "migration";
export type InviteStatus = "active" | "expired" | "exhausted" | "revoked";
export type OfficerInvitationStatus = "sent" | "accepted" | "declined" | "expired" | "revoked";

export interface User {
  id: string;
  full_name: string;
  phone_e164: string | null;
  email: string | null;
  avatar_url: string | null;
  identity_level: "none" | "contact_verified" | "identity_verified";
  status: "active" | "suspended" | "closed";
  created_at: string;
}

export interface Community {
  id: string;
  slug: string;
  name: string;
  type: CommunityType;
  status: CommunityStatus;
  is_personal: boolean;
  description: string | null;
  logo_url: string | null;
  location_state: string | null;
  location_city: string | null;
  institution: string | null;
  contact_email: string | null;
  contact_phone_e164: string | null;
  verification_status: VerificationStatus;
  show_officers_publicly: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface OfficerTerm {
  id: string;
  community_id: string;
  user_id: string;
  role: OfficerRole;
  title: string | null;
  scope: { collection_ids?: string[]; group_ids?: string[] } | null;
  started_at: string;
  ended_at: string | null;
  start_reason: string;
  end_reason: string | null;
  actor_name_snapshot: string;
}

/**
 * A person on a community roll.
 *
 * Two identities, and they are not the same thing (§5). `member_code` is
 * Kolekto's — KWASU/0021, issued by the database, stable, what a contributor
 * types to find themselves. The community's own identifying field — a matric
 * number, a house number — is not a column here at all: it is one of the
 * community's `member_attribute_definitions`, marked primary, with its value in
 * `member_attribute_values`. That is what lets a school and an estate identify
 * their people differently without either one bending a column named for the
 * other.
 */
export interface Member {
  id: string;
  community_id: string;
  full_name: string;
  phone_e164: string | null;
  email: string | null;
  member_code: string | null;
  status: MemberStatus;
  joined_via: MemberJoinedVia;
  is_entity: boolean;
  user_id: string | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface MemberAttributeDefinition {
  id: string;
  community_id: string;
  key: string;
  label: string;
  type: MemberAttributeType;
  options: string[] | null;
  required_at_join: boolean;
  is_unique: boolean;
  is_primary_identifier: boolean;
  sort_order: number;
  created_at: string;
}

export interface MemberAttributeValue {
  member_id: string;
  definition_id: string;
  community_id: string;
  value_text: string;
  /** Trimmed and case-folded. What uniqueness and search compare; never shown. */
  value_norm: string;
  is_unique: boolean;
}

export interface CommunityMemberCodeSettings {
  community_id: string;
  prefix: string | null;
  padding: number;
  next_number: number;
}

/** One duplicate candidate from `app.find_member_duplicates`. `exact` means the community's own unique field already belongs to someone; `possible` means a shared phone, email or name. */
export interface MemberDuplicate {
  member_id: string;
  full_name: string;
  member_code: string | null;
  status: MemberStatus;
  match_reason: string;
  match_strength: "exact" | "possible";
}

export interface MemberGroup {
  id: string;
  community_id: string;
  name: string;
  description: string | null;
  pickable_at_join: boolean;
  sort_order: number;
  archived_at: string | null;
  created_at: string;
}

export interface InviteLink {
  id: string;
  community_id: string;
  token_prefix: string;
  group_ids: string[];
  allow_group_choice: boolean;
  allow_multi_group: boolean;
  approve_joiners: boolean;
  expires_at: string | null;
  max_uses: number | null;
  uses: number;
  status: InviteStatus;
  label: string | null;
  created_by: string;
  created_at: string;
}

export interface OfficerInvitation {
  id: string;
  community_id: string;
  role: OfficerRole;
  title: string | null;
  invitee_name: string | null;
  invitee_phone_e164: string | null;
  invitee_email: string | null;
  status: OfficerInvitationStatus;
  expires_at: string;
  accepted_at: string | null;
  invited_by: string;
  created_at: string;
}

export type CollectionCategory = "dues" | "contribution" | "event" | "fundraiser" | "items" | "other";
export type ParticipationMode = "open" | "managed";
export type AmountModel = "fixed" | "open_amount" | "tiers" | "per_member" | "items";
export type PaymentPlan = "full_only" | "installments_allowed";
export type CollectionSchedule = "one_time" | "recurring";
export type CollectionStatus = "draft" | "scheduled" | "active" | "paused" | "closed" | "suspended" | "archived";
export type CollectionVisibility = "public" | "unlisted" | "members_only";
export type CollectionAudienceModeValue = "all_members" | "groups" | "selected_members" | "public";
export type FeeMode = "community_absorbs" | "contributor_pays";
export type MemberAttributeType = "text" | "number" | "single_select" | "date";
export type ObligationStatus = "unpaid" | "in_installments" | "overdue" | "paid" | "exempt" | "cancelled";

/**
 * Kobo columns read through PostgREST arrive as JSON numbers (see
 * `generated-types.ts`). They are whole numbers well inside the safe integer
 * range at any plausible collection size, and every display and comparison
 * converts through `@kolekto/domain`'s `kobo()` rather than doing arithmetic on
 * them here — ADR 0003's rule is that money is manipulated in exactly one
 * module, not that it may never cross a JSON boundary.
 */
export interface Collection {
  id: string;
  community_id: string;
  slug: string;
  name: string;
  description: string | null;
  cover_image_url: string | null;
  category: CollectionCategory;
  participation_mode: ParticipationMode;
  /** Who the collection is for. Paired with participation_mode by a database constraint, so the two cannot disagree. */
  audience_mode: CollectionAudienceModeValue;
  amount_model: AmountModel;
  payment_plan: PaymentPlan;
  schedule: CollectionSchedule;
  fixed_amount_kobo: number | null;
  min_amount_kobo: number | null;
  max_amount_kobo: number | null;
  target_amount_kobo: number | null;
  /** One-tap choices on an open collection. Suggestions only — the server still resolves the figure charged. */
  suggested_amounts_kobo: number[];
  /** When the event happens, as distinct from when the collection sells tickets for it. */
  event_starts_at: string | null;
  event_ends_at: string | null;
  venue: string | null;
  starts_at: string | null;
  deadline_at: string | null;
  status: CollectionStatus;
  visibility: CollectionVisibility;
  display_options: Record<string, boolean>;
  fee_mode: FeeMode;
  allow_non_members: boolean;
  codes_enabled: boolean;
  allow_anonymous: boolean;
  thank_you_message: string | null;
  created_by: string;
  published_by: string | null;
  published_at: string | null;
  closed_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CollectionTier {
  id: string;
  collection_id: string;
  community_id: string;
  name: string;
  description: string | null;
  price_kobo: number;
  quantity_limit: number | null;
  per_order_limit: number | null;
  code_prefix: string | null;
  hidden: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface CollectionItem {
  id: string;
  collection_id: string;
  community_id: string;
  name: string;
  description: string | null;
  price_kobo: number;
  /** Absent means unlimited, which is not the same as zero left. */
  quantity_available: number | null;
  max_per_order: number | null;
  image_url: string | null;
  hidden: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface CollectionRecurrence {
  collection_id: string;
  community_id: string;
  frequency: RecurrenceFrequencyValue;
  interval_count: number;
  starts_on: string;
  due_after_days: number;
  created_at: string;
  updated_at: string;
}

export type RecurrenceFrequencyValue = "weekly" | "monthly" | "quarterly" | "yearly";

/** One period of a recurring collection. `cycle_key` is the label obligations are filed under. */
export interface CollectionCycleRow {
  id: string;
  collection_id: string;
  community_id: string;
  cycle_key: string;
  period_start: string;
  period_end: string;
  due_at: string | null;
  opened_by: string | null;
  opened_at: string;
  closed_at: string | null;
}

export interface CollectionField {
  id: string;
  collection_id: string;
  community_id: string;
  key: string;
  label: string;
  type: MemberAttributeType;
  options: string[] | null;
  required: boolean;
  sort_order: number;
  created_at: string;
}

/**
 * What one member is expected to pay toward one collection.
 *
 * There is no `amount_paid`, and its absence is the design (OBL-01, ADR 0006):
 * what has been paid is derived from contributions, which do not exist yet. A
 * screen that wants to show a balance shows `expected_amount_kobo` minus
 * `waived_amount_kobo` and says what that figure is — never a paid total.
 */
export interface Obligation {
  id: string;
  community_id: string;
  collection_id: string;
  member_id: string;
  cycle_key: string | null;
  expected_amount_kobo: number;
  waived_amount_kobo: number;
  waived_reason: string | null;
  waived_by: string | null;
  waived_at: string | null;
  due_at: string | null;
  exempt: boolean;
  exempt_reason: string | null;
  exempt_by: string | null;
  exempt_at: string | null;
  status: ObligationStatus;
  version: number;
  assigned_by: string | null;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
}

export interface Permission {
  key: string;
  description: string;
}

export interface AuditLog {
  id: string;
  community_id: string | null;
  actor_type: "officer" | "member" | "contributor" | "staff" | "system";
  actor_name_snapshot: string;
  actor_role: OfficerRole | null;
  action: string;
  object_type: string;
  object_id: string | null;
  reason: string | null;
  created_at: string;
}
