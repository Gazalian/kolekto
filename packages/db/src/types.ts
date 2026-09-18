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

export interface Member {
  id: string;
  community_id: string;
  full_name: string;
  phone_e164: string | null;
  email: string | null;
  identifier: string | null;
  attributes: Record<string, string | number | null>;
  status: MemberStatus;
  joined_via: MemberJoinedVia;
  user_id: string | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface MemberGroup {
  id: string;
  community_id: string;
  name: string;
  description: string | null;
  pickable_at_join: boolean;
  sort_order: number;
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
