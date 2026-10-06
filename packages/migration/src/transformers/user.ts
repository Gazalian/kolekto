/**
 * Legacy profile → new user / personal community / owner term, per F-M1/F-L1.
 *
 * Every legacy authenticated user becomes:
 *   1. an auth.users row with the same UUID (preserved) — inserted by the
 *      orchestrator; not modelled here;
 *   2. a public.users row from profile fields (name, phone, email, avatar_url=null);
 *   3. one personal community (COM-01);
 *   4. an owner term with start_reason='migration'.
 *
 * If the profile has no phone, the user still lands but the members table
 * cannot list them as active — that's an obligation of the members transform,
 * not this one.
 */

export interface LegacyProfile {
  readonly id: string;
  readonly full_name: string | null;
  readonly email: string | null;
  readonly phone_number: string | null;
  readonly avatar_url: string | null;
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly address: string | null;
  readonly date_of_birth: string | null;
  readonly signup_ip: string | null;
  readonly role: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface NewUserRow {
  readonly id: string;                    // preserved from auth.users
  readonly full_name: string;
  readonly email: string | null;          // citext at destination; passthrough
  readonly phone_e164: string | null;
  readonly avatar_url: null;              // D10
}

export interface NewPersonalCommunityRow {
  readonly id: string;                    // fresh UUID
  readonly created_by: string;            // = user id
  readonly name: string;                  // e.g. "Ada's collections"
  readonly slug_hint: string;             // slug is finalised in the DB with generate_unique_community_slug
  readonly is_personal: true;
  readonly type: "personal";
}

export interface NewOwnerTermRow {
  readonly community_id: string;
  readonly user_id: string;
  readonly role: "owner";
  readonly actor_name_snapshot: string;
  readonly start_reason: "migration";
}

const NEW_NAME_MAX = 66;
const NEW_COMMUNITY_MAX = 80;

function fallbackName(profile: LegacyProfile): string {
  const composed = [profile.first_name, profile.last_name].filter((v) => v && v.trim()).join(" ").trim();
  if (composed) return composed.slice(0, NEW_NAME_MAX);
  if (profile.full_name && profile.full_name.trim()) return profile.full_name.trim().slice(0, NEW_NAME_MAX);
  if (profile.email && profile.email.includes("@")) return profile.email.split("@")[0]!.slice(0, NEW_NAME_MAX);
  return "New member";
}

export interface TransformUserInput {
  readonly profile: LegacyProfile;
  readonly newCommunityId: string;
}

export interface TransformUserOutput {
  readonly user: NewUserRow;
  readonly community: NewPersonalCommunityRow;
  readonly term: NewOwnerTermRow;
}

export function transformUser({ profile, newCommunityId }: TransformUserInput): TransformUserOutput {
  const full_name = fallbackName(profile);
  const communityName = `${full_name}'s collections`.slice(0, NEW_COMMUNITY_MAX);
  return {
    user: {
      id: profile.id,
      full_name,
      email: profile.email && profile.email.trim() ? profile.email.trim() : null,
      phone_e164: profile.phone_number && profile.phone_number.trim() ? profile.phone_number.trim() : null,
      avatar_url: null,
    },
    community: {
      id: newCommunityId,
      created_by: profile.id,
      name: communityName,
      slug_hint: (full_name || "my").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") + "-collections",
      is_personal: true,
      type: "personal",
    },
    term: {
      community_id: newCommunityId,
      user_id: profile.id,
      role: "owner",
      actor_name_snapshot: full_name,
      start_reason: "migration",
    },
  };
}
