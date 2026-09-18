import { loadConfig } from "@kolekto/config";
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PATHS = ["/login", "/invite", "/accept-invite"];

function isPublicPath(pathname: string): boolean {
  return pathname === "/" || PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
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

  if (!user && !isPublicPath(request.nextUrl.pathname)) {
    const redirectUrl = new URL("/login", request.url);
    redirectUrl.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(redirectUrl);
  }

  if (user && request.nextUrl.pathname === "/login") {
    return NextResponse.redirect(new URL("/communities", request.url));
  }

  return response;
}
