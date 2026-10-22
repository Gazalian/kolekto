/**
 * client.ts — the one direct-Postgres connection in the codebase.
 *
 * Why this exists at all: PostgREST serves `public` only
 * (`supabase/config.toml`, `[api] schemas = ["public"]`). Every write function
 * this application calls lives in `app`
 * (20260918140100_application_write_functions.sql), by design — it is what
 * keeps a browser holding a publishable key from ever reaching them, no
 * matter what grants say (see that migration's own header). The only way
 * server code can call an `app` function is a direct connection to Postgres,
 * bypassing PostgREST entirely.
 *
 * That means this module also bypasses PostgREST's normal role switching, so
 * it does that switching itself, per call, in `withCallerContext` below —
 * exactly the pattern `supabase/tests/*.sql` uses to simulate a caller
 * (`set local role authenticated; set local request.jwt.claims = ...`). This
 * is what keeps `auth.uid()`, `app.has_permission` and every RLS policy
 * behaving identically whether a query arrived through PostgREST or here.
 *
 * SERVER ONLY. Never imported by a client component — `loadDatabaseUrl()`
 * throws if it is.
 */

import { loadDatabaseUrl } from "@kolekto/config";
import postgres from "postgres";

let client: postgres.Sql | undefined;

function getClient(): postgres.Sql {
  client ??= postgres(loadDatabaseUrl(), {
    prepare: false,
    // Money paths never run through this connection (only app schema writes
    // that are not money — ADR 0006), but bigint columns still round-trip
    // through it (ids, counts), so keep them as strings rather than lossy
    // JS numbers.
    transform: { undefined: null },
  });
  return client;
}

/** Who the call is made on behalf of. `userId: null` impersonates `anon` — the one path with any write access at all is app.redeem_invite_link (MEM-05). */
export interface CallerContext {
  readonly userId: string | null;
}

export const ANONYMOUS: CallerContext = { userId: null };

/**
 * Runs `fn` inside a transaction impersonating `caller`. Every write function
 * in `packages/db/src/write.ts` goes through this — never call `getClient()`
 * directly outside this file, or a query runs as the connection's own
 * (privileged) role instead of the caller's, defeating every permission check
 * the write functions perform.
 */
export async function withCallerContext<T>(
  caller: CallerContext,
  fn: (sql: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  // Cast needed because postgres.js's own `begin<T>` return type
  // (`UnwrapPromiseArray<T>`) special-cases `T` being an array/tuple in a way
  // TS cannot prove equals `T` for an arbitrary generic here. Every caller in
  // write.ts returns a plain object or void, never an array, so the shapes
  // are identical at every actual call site.
  return getClient().begin(async (tx) => {
    if (caller.userId) {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: caller.userId, role: "authenticated" })}, true)`;
      await tx`set local role authenticated`;
    } else {
      await tx`set local role anon`;
    }
    return fn(tx);
  }) as Promise<T>;
}

/**
 * A write function raised `RAISE EXCEPTION 'CODE: message' USING ERRCODE = X`
 * (the convention every function in 20260918140100 follows). Parsed into a
 * stable `code` a server action can switch on, instead of matching prose.
 */
export class DatabaseError extends Error {
  readonly code: string;
  readonly sqlState: string | undefined;

  constructor(pgError: unknown) {
    const raw = pgError instanceof Error ? pgError.message : String(pgError);
    const match = /^([A-Z_]+):\s*(.*)$/s.exec(raw);
    super(match ? match[2] : raw);
    this.name = "DatabaseError";
    this.code = match ? match[1]! : "UNKNOWN";
    this.sqlState = (pgError as { code?: string } | undefined)?.code;
  }
}

/** Wraps a write-function call so every caller gets a `DatabaseError`, never a raw driver exception leaking implementation detail into a server action's catch block. */
export async function runWrite<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new DatabaseError(error);
  }
}

/**
 * Runs `fn` inside a transaction on the base connection with NO role switch
 * applied — i.e. as the connection's owner role. `current_setting('role',
 * true)` returns the empty string, which every operator-only `app.*` function
 * in this codebase treats as `none` (`coalesce(nullif(current_setting('role',
 * true), ''), 'none')` is the single idiom used by every setter).
 *
 * The ONLY intended callers are server-side handlers for inbound provider
 * webhooks (SES/SNS event ingestion, M13.2 P9-2) that need to invoke
 * operator-level entry points after authenticating the request. Every other
 * write goes through `withCallerContext` so the acting user's permissions
 * and RLS apply. A caller that reaches for this helper for anything else is
 * writing a bug.
 *
 * SERVER ONLY. `loadDatabaseUrl()` throws in the browser.
 */
export async function withOwnerConnection<T>(
  fn: (sql: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  // Narrow the postgres.js generic return type the same way withCallerContext
  // does, for the same reason.
  return getClient().begin(async (tx) => fn(tx)) as Promise<T>;
}

/** Test/dev only: closes the pool so a script can exit. Never called from request-handling code. */
export async function closeClient(): Promise<void> {
  await client?.end();
  client = undefined;
}
