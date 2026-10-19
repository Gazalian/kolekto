/**
 * notifications.ts — deterministic in-app notification fixtures for the browser
 * suite.
 *
 * The real pipeline is audit_log → pgmq → worker → notification_deliveries, and
 * it is exercised end-to-end by the backend's own integration tests. A browser
 * test of the *bell and panel* should not also depend on queue timing and the
 * 15s client poll to observe its fixtures — that is the "flaky sleep" the brief
 * tells us to avoid. So this helper writes the same rows the worker would.
 *
 * It seeds over a DIRECT Postgres connection (the superuser `SUPABASE_DB_URL`,
 * the same one scripts/verify and the pgTAP suite use), NOT the service-role
 * REST key: migration 20260928110000 deliberately strips `service_role` of all
 * application-table privileges (F-1), so PostgREST-as-service_role cannot read
 * `public.users`. A direct connection is also how the rest of the test estate
 * seeds fixtures, and it never runs in the application — only here, in tests.
 *
 * Seeding only stands in for the worker's INSERTs. Reading and mark-as-read
 * stay under test through the real browser client and the real `app.*`
 * SECURITY DEFINER functions. Each spec signs up a brand-new user, so seeded
 * rows are naturally isolated and need no teardown.
 */

import { randomUUID } from "node:crypto";
import postgres from "postgres";

const DB_URL =
  process.env.DATABASE_URL ??
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

type Sql = postgres.Sql<Record<string, never>>;

/** Opens a short-lived superuser connection, runs `fn`, and always closes it so no handle keeps the Playwright worker alive. */
async function withSql<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
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
  return withSql(async (sql) => {
    const [user] = await sql<{ id: string }[]>`
      select id from public.users where email = ${email}
    `;
    if (!user) throw new Error(`Could not resolve a user for ${email}: no public.users row`);

    const [term] = await sql<{ community_id: string; community_slug: string }[]>`
      select ot.community_id, c.slug as community_slug
      from public.officer_terms ot
      join public.communities c on c.id = ot.community_id
      where ot.user_id = ${user.id} and ot.ended_at is null
      order by ot.started_at asc
      limit 1
    `;
    if (!term) throw new Error(`Could not resolve a community for ${email}: no active officer term`);

    return { userId: user.id, communityId: term.community_id, communitySlug: term.community_slug };
  });
}

export interface NotificationSpec {
  eventType: "collection.publish" | "member.approve_join" | "member.join_via_invite";
  payload: Record<string, unknown>;
  /** Seed as already-read (default false → unread). */
  read?: boolean;
  /** ISO timestamp for created_at; defaults to now. Use to order a list deterministically. */
  createdAt?: string;
}

interface Target {
  communityId: string;
  actorUserId: string;
  recipientUserId: string;
}

/** Writes one notification_event and one in-app delivery, returning the delivery id. */
async function insertNotification(sql: Sql, target: Target, spec: NotificationSpec): Promise<string> {
  const objectId = randomUUID();
  const objectType = spec.eventType.split(".")[0]!; // "collection" | "member"
  const eventKey = `e2e:${spec.eventType}:${objectId}`;
  const createdAt = spec.createdAt ? new Date(spec.createdAt) : new Date();
  const payload = { community_id: target.communityId, ...spec.payload };

  const [event] = await sql<{ id: string }[]>`
    insert into public.notification_events
      (community_id, event_type, event_key, actor_type, actor_user_id, object_type, object_id, payload, created_at)
    values
      (${target.communityId}, ${spec.eventType}, ${eventKey}, 'officer', ${target.actorUserId},
       ${objectType}, ${objectId}, ${sql.json(payload)}, ${createdAt})
    returning id
  `;
  if (!event) throw new Error("Failed to seed notification_event");

  const [delivery] = await sql<{ id: string }[]>`
    insert into public.notification_deliveries
      (notification_event_id, community_id, recipient_user_id, channel, status, read_at, created_at)
    values
      (${event.id}, ${target.communityId}, ${target.recipientUserId}, 'in_app', 'sent',
       ${spec.read ? new Date() : null}, ${createdAt})
    returning id
  `;
  if (!delivery) throw new Error("Failed to seed notification_delivery");

  return delivery.id;
}

/** Seeds the given notifications for the user, newest last in the array. Returns the created delivery ids. */
export async function seedNotifications(ctx: SeedContext, specs: NotificationSpec[]): Promise<string[]> {
  return withSql(async (sql) => {
    const ids: string[] = [];
    for (const spec of specs) {
      ids.push(
        await insertNotification(sql, { communityId: ctx.communityId, actorUserId: ctx.userId, recipientUserId: ctx.userId }, spec),
      );
    }
    return ids;
  });
}

/** Reads a seeded delivery's read state directly (used only to assert the UI reflects server state). */
export async function readStateOf(deliveryId: string): Promise<{ read: boolean }> {
  return withSql(async (sql) => {
    const [row] = await sql<{ read_at: string | null }[]>`
      select read_at from public.notification_deliveries where id = ${deliveryId}
    `;
    if (!row) throw new Error(`Could not read delivery ${deliveryId}: no row`);
    return { read: row.read_at != null };
  });
}

/**
 * Creates a second user the way the pgTAP fixtures do — an auth.users row (the
 * `handle_new_auth_user` trigger populates public.users) plus a defensive
 * public.users upsert — and returns its id. Used to prove the inbox is scoped
 * to the signed-in recipient, not merely to the community.
 */
export async function createForeignUser(): Promise<string> {
  return withSql(async (sql) => {
    const id = randomUUID();
    const email = `e2e-foreign-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
    await sql`
      insert into auth.users (id, instance_id, aud, role, email)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${email})
    `;
    await sql`
      insert into public.users (id, full_name, email)
      values (${id}, 'Foreign E2E User', ${email})
      on conflict (id) do nothing
    `;
    return id;
  });
}

/**
 * Seeds one unread in-app notification whose recipient is ANOTHER user, in the
 * current user's community. The community's officer RLS policy would expose it
 * to officers, so a correctly scoped bell must still exclude it.
 */
export async function seedForeignNotification(ctx: SeedContext, foreignUserId: string): Promise<string> {
  return withSql((sql) =>
    insertNotification(
      sql,
      { communityId: ctx.communityId, actorUserId: ctx.userId, recipientUserId: foreignUserId },
      { eventType: "collection.publish", payload: { community_slug: ctx.communitySlug, collection_name: "Private to someone else" } },
    ),
  );
}
