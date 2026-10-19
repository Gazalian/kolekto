/**
 * notifications.ts — deterministic in-app notification fixtures for the browser
 * suite.
 *
 * The real pipeline is audit_log → pgmq → worker → notification_deliveries, and
 * it is exercised end-to-end by the backend's own integration tests. A browser
 * test of the *bell and panel* should not also depend on queue timing and the
 * 15s client poll to observe its fixtures — that is the "flaky sleep" the brief
 * tells us to avoid. So this helper writes the same rows the worker would, with
 * the service-role key (bypassing RLS to seed, exactly as a server-side
 * producer does), giving each test a fixed, known inbox.
 *
 * It never touches auth, RLS or the mark-as-read path — those stay under test
 * through the real browser client and the real `app.*` SECURITY DEFINER
 * functions. Seeding only stands in for the worker's INSERTs.
 *
 * Each spec signs up a brand-new user, so seeded rows are naturally isolated
 * and need no teardown (notification_events is append-only — its delete trigger
 * blocks cleanup anyway, by design).
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function admin(): SupabaseClient {
  if (!SERVICE_ROLE_KEY) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. The notification e2e fixtures seed rows with the " +
        "service-role key; export it (CI does) before running tests/e2e/notifications.spec.ts.",
    );
  }
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export interface SeedContext {
  userId: string;
  communityId: string;
  communitySlug: string;
}

/**
 * Resolves the signed-up user and the community they own from their email. The
 * onboarding flow the auth helper runs always leaves the user holding an active
 * officer term in exactly one freshly created community.
 */
export async function resolveSeedContext(email: string): Promise<SeedContext> {
  const db = admin();

  const { data: user, error: userError } = await db
    .from("users")
    .select("id")
    .eq("email", email)
    .single();
  if (userError || !user) {
    throw new Error(`Could not resolve a user for ${email}: ${userError?.message ?? "no row"}`);
  }

  const { data: term, error: termError } = await db
    .from("officer_terms")
    .select("community_id, communities(slug)")
    .eq("user_id", user.id)
    .is("ended_at", null)
    .order("started_at", { ascending: true })
    .limit(1)
    .single();
  if (termError || !term) {
    throw new Error(`Could not resolve a community for ${email}: ${termError?.message ?? "no officer term"}`);
  }

  const communities = term.communities as unknown as { slug: string } | { slug: string }[] | null;
  const slug = Array.isArray(communities) ? communities[0]?.slug : communities?.slug;
  if (!slug) {
    throw new Error(`Officer term for ${email} has no community slug`);
  }

  return { userId: user.id, communityId: term.community_id as string, communitySlug: slug };
}

export interface NotificationSpec {
  eventType: "collection.publish" | "member.approve_join" | "member.join_via_invite";
  payload: Record<string, unknown>;
  /** Seed as already-read (default false → unread). */
  read?: boolean;
  /** ISO timestamp for created_at; defaults to now. Use to order a list deterministically. */
  createdAt?: string;
}

/**
 * Writes one notification_event and one in-app delivery for the given user,
 * returning the delivery id. `objectType` defaults to the event's object noun.
 */
async function seedOne(
  db: SupabaseClient,
  ctx: SeedContext,
  spec: NotificationSpec,
): Promise<string> {
  const objectId = randomUUID();
  const objectType = spec.eventType.split(".")[0]!; // "collection" | "member"
  const eventKey = `e2e:${spec.eventType}:${objectId}`;

  const { data: event, error: eventError } = await db
    .from("notification_events")
    .insert({
      community_id: ctx.communityId,
      event_type: spec.eventType,
      event_key: eventKey,
      actor_type: "user",
      actor_user_id: ctx.userId,
      object_type: objectType,
      object_id: objectId,
      payload: { community_id: ctx.communityId, ...spec.payload },
      ...(spec.createdAt ? { created_at: spec.createdAt } : {}),
    })
    .select("id")
    .single();
  if (eventError || !event) {
    throw new Error(`Failed to seed notification_event: ${eventError?.message ?? "no row"}`);
  }

  const { data: delivery, error: deliveryError } = await db
    .from("notification_deliveries")
    .insert({
      notification_event_id: event.id,
      community_id: ctx.communityId,
      recipient_user_id: ctx.userId,
      channel: "in_app",
      status: "sent",
      read_at: spec.read ? new Date().toISOString() : null,
      ...(spec.createdAt ? { created_at: spec.createdAt } : {}),
    })
    .select("id")
    .single();
  if (deliveryError || !delivery) {
    throw new Error(`Failed to seed notification_delivery: ${deliveryError?.message ?? "no row"}`);
  }

  return delivery.id as string;
}

/** Seeds the given notifications for the user, newest last in the array. Returns the created delivery ids. */
export async function seedNotifications(ctx: SeedContext, specs: NotificationSpec[]): Promise<string[]> {
  const db = admin();
  const ids: string[] = [];
  for (const spec of specs) {
    ids.push(await seedOne(db, ctx, spec));
  }
  return ids;
}

/** Marks a seeded delivery's read_at directly (used only to assert the UI reflects server state). */
export async function readStateOf(deliveryId: string): Promise<{ read: boolean }> {
  const db = admin();
  const { data, error } = await db
    .from("notification_deliveries")
    .select("read_at")
    .eq("id", deliveryId)
    .single();
  if (error || !data) throw new Error(`Could not read delivery ${deliveryId}: ${error?.message ?? "no row"}`);
  return { read: data.read_at != null };
}

/**
 * Creates a second auth user via the admin API (the auth.users INSERT trigger
 * populates public.users), returning its id. Used to prove the inbox is scoped
 * to the signed-in recipient, not merely to the community.
 */
export async function createForeignUser(): Promise<string> {
  const db = admin();
  const email = `e2e-foreign-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const { data, error } = await db.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: "Foreign E2E User" },
  });
  if (error || !data.user) {
    throw new Error(`Could not create a foreign user: ${error?.message ?? "no user"}`);
  }
  return data.user.id;
}

/**
 * Seeds one unread in-app notification whose recipient is ANOTHER user, in the
 * current user's community. The community's officer RLS policy would expose it
 * to officers, so a correctly scoped bell must still exclude it.
 */
export async function seedForeignNotification(ctx: SeedContext, foreignUserId: string): Promise<string> {
  const db = admin();
  return seedOne(db, { ...ctx, userId: foreignUserId }, {
    eventType: "collection.publish",
    payload: { community_slug: ctx.communitySlug, collection_name: "Private to someone else" },
  });
}
