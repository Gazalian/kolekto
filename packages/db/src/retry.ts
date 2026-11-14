/**
 * retry.ts — recovering from a database connection that died while idle.
 *
 * The direct-Postgres client keeps connections in a pool between requests. On
 * a laptop running the stack in Docker Desktop, those connections are cut
 * whenever Docker restarts, the machine sleeps, or the virtual network drops
 * an idle socket. The pool does not know until it next uses one, and that
 * query then fails with `ECONNRESET` (or `CONNECTION_CLOSED`). Before this,
 * that failure surfaced as a full error page — most visibly on a Fixed or
 * Recurring draft, whose page is the first to touch this client.
 *
 * ── WHEN A RETRY IS SAFE ────────────────────────────────────────────────────
 *
 * Only when the work never started. `run` receives `markStarted`, which the
 * caller invokes immediately before handing the transaction to the real work.
 * A dead pooled socket fails on the very first statement (`BEGIN`, or the
 * role switch that follows it), before `markStarted` — nothing was sent that
 * could have changed anything, so running it again on a fresh connection is
 * exactly equivalent to the first attempt succeeding.
 *
 * Once the work has started, a connection error is NOT retried: a write may
 * have reached the server (or even committed just before the reset), and
 * repeating it could do it twice. That error is thrown as it always was.
 */

/** postgres.js and Node socket codes that mean "this connection is gone", not "this query is wrong". */
const CONNECTION_ERROR_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "CONNECT_TIMEOUT",
]);

export function isConnectionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && CONNECTION_ERROR_CODES.has(code)) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /\b(ECONNRESET|EPIPE|write CONNECTION_CLOSED|CONNECTION_CLOSED)\b/.test(message);
}

/**
 * Runs `run`, retrying once on a fresh connection if it failed with a
 * connection error BEFORE `markStarted` was called. See the header for why
 * that line is the safe one.
 */
export async function retryIfNotStarted<T>(
  run: (markStarted: () => void) => Promise<T>,
  attempts = 2,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    let started = false;
    try {
      return await run(() => {
        started = true;
      });
    } catch (error) {
      if (!started && attempt < attempts && isConnectionError(error)) continue;
      throw error;
    }
  }
}
