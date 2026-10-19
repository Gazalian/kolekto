import { loadConfig } from "@kolekto/config";
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const AUTH_PATHS = ["/login", "/signup", "/verify", "/forgot-password", "/reset-password"];
const ONBOARDING_PATHS = ["/welcome", "/setup"];
const PUBLIC_PATHS = [...AUTH_PATHS, "/invite", "/accept-invite", "/auth/callback"];

/**
 * First path segments that belong to the application itself, and therefore
 * cannot be a community's public address. A community slug is at least three
 * characters (communities_slug_format), so "c" could never collide; the rest
 * could, and a community whose slug is one of these words would have its
 * public page shadowed by the app's own route. Slug allocation does not yet
 * exclude them — noted in the Phase 3 report as a follow-up, because fixing it
 * means changing how Phase 2 allocates community slugs.
 */
const APP_SEGMENTS = new Set([
  "c",
  "communities",
  "login",
  "logout",
  "signup",
  "verify",
  "forgot-password",
  "reset-password",
  "welcome",
  "setup",
  "account",
  "notifications",
  "invite",
  "accept-invite",
  "auth",
  "api",
]);

/**
 * `/{community-slug}/{collection-slug}` — the published collection page. It is
 * public because a contributor has no account and is never asked for one
 * (section 16 of the Phase 3 brief; SEC-12 in the schema).
 *
 * The page itself reads through `app.get_public_collection`, which returns
 * whitelisted columns for published collections only. This check decides
 * whether to bounce the request to a sign-in page, nothing more.
 */
function isPublicCollectionPath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  return segments.length === 2 && !APP_SEGMENTS.has(segments[0]!);
}

function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
    isPublicCollectionPath(pathname)
  );
}

function isAuthPath(pathname: string): boolean {
  return AUTH_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function isOnboardingPath(pathname: string): boolean {
  return ONBOARDING_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Refreshes the Supabase session cookie on every request (@supabase/ssr's
 * required middleware pattern — without this, a Server Component sees a
 * stale or expired session) and redirects unauthenticated requests away from
 * everything but the public paths above.
 *
 * UI-level protection only (section 14: "UI visibility is NOT security").
 * Every table this app reads is still behind RLS, and every write still goes
 * through a permission-checked database function — this middleware exists so
 * a signed-out visitor sees a sign-in page instead of a page that loads and
 * then shows nothing.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const config = loadConfig();

  const supabase = createServerClient(config.supabaseUrl, config.supabasePublishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;

  if (!user && !isPublicPath(pathname)) {
    const redirectUrl = new URL("/login", request.url);
    redirectUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(redirectUrl);
  }

  if (user) {
    if (isAuthPath(pathname) && !pathname.startsWith("/reset-password")) {
      return NextResponse.redirect(new URL("/communities", request.url));
    }

    if (!isPublicPath(pathname) || isOnboardingPath(pathname)) {
      const { data: userRow } = await supabase
        .from("users")
        .select("onboarding_completed_at")
        .eq("id", user.id)
        .single();

      const onboarded = !!userRow?.onboarding_completed_at;

      if (!onboarded && !isOnboardingPath(pathname)) {
        return NextResponse.redirect(new URL("/welcome", request.url));
      }

      if (onboarded && isOnboardingPath(pathname)) {
        return NextResponse.redirect(new URL("/communities", request.url));
      }
    }
  }

  return response;
}
