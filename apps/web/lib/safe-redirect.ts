const DEFAULT_PATH = "/communities";

/**
 * Returns `path` unchanged when it is a safe internal application path, or
 * the default (`/communities`) when it is not.
 *
 * A safe path starts with a single `/` and does not contain a protocol,
 * authority, or any other construct that could redirect to an external origin.
 */
export function safeRedirectPath(path: string | null | undefined): string {
  if (typeof path !== "string" || path === "") return DEFAULT_PATH;
  if (!path.startsWith("/")) return DEFAULT_PATH;
  if (path.startsWith("//")) return DEFAULT_PATH;
  if (path.includes("://")) return DEFAULT_PATH;
  if (path.toLowerCase().startsWith("/\\")) return DEFAULT_PATH;
  return path;
}
