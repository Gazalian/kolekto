import { loadConfig } from "@kolekto/config";
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";
  const errorDescription = searchParams.get("error_description");

  if (errorDescription) {
    const target = new URL(next === "/" ? "/forgot-password" : next, origin);
    target.searchParams.set("error", errorDescription);
    return NextResponse.redirect(target);
  }

  if (code) {
    const config = loadConfig();
    const redirectUrl = new URL(next, origin);
    const response = NextResponse.redirect(redirectUrl);

    const supabase = createServerClient(config.supabaseUrl, config.supabasePublishableKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    });

    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      return response;
    }
  }

  const fallback = new URL("/forgot-password", origin);
  fallback.searchParams.set("error", "Reset link is invalid or has expired. Please request a new one.");
  return NextResponse.redirect(fallback);
}
