import { NextResponse } from "next/server";
import { describe, expect, it } from "vitest";
import {
  isAuthPath,
  isOnboardingPath,
  isPublicCollectionPath,
  isPublicPath,
  redirectWithRefreshedCookies,
} from "./middleware.ts";

/**
 * Unit tests for the pure helpers inside `middleware.ts`. These do not
 * exercise `updateSession` or Supabase: `updateSession` reads real cookies
 * and talks to a real Auth server, which the project's E2E suite covers
 * against the local stack. The helpers below are shape-only, so this is the
 * right place for them — and the redirect-cookies helper is the piece whose
 * absence shipped the "session terminated prematurely" bug (@supabase/ssr).
 */

describe("isPublicPath", () => {
  it("accepts the root and every auth path (plus descendants)", () => {
    expect(isPublicPath("/")).toBe(true);
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/login/with-trail")).toBe(true);
    expect(isPublicPath("/signup")).toBe(true);
    expect(isPublicPath("/verify")).toBe(true);
    expect(isPublicPath("/forgot-password")).toBe(true);
    expect(isPublicPath("/reset-password")).toBe(true);
  });

  it("accepts invite, accept-invite and the Supabase auth callback", () => {
    expect(isPublicPath("/invite/abc")).toBe(true);
    expect(isPublicPath("/accept-invite/xyz")).toBe(true);
    expect(isPublicPath("/auth/callback")).toBe(true);
    expect(isPublicPath("/auth/callback/?code=abc")).toBe(true);
  });

  it("accepts a two-segment community/collection path", () => {
    expect(isPublicPath("/my-community/my-collection")).toBe(true);
  });

  it("rejects every protected app route (no redirect-loop fuel)", () => {
    expect(isPublicPath("/communities")).toBe(false);
    expect(isPublicPath("/c/my-community")).toBe(false);
    expect(isPublicPath("/c/my-community/collections")).toBe(false);
    expect(isPublicPath("/account")).toBe(false);
    expect(isPublicPath("/notifications")).toBe(false);
    expect(isPublicPath("/welcome")).toBe(false);
    expect(isPublicPath("/setup/type")).toBe(false);
  });
});

describe("isAuthPath", () => {
  it("matches the auth routes themselves and their descendants", () => {
    expect(isAuthPath("/login")).toBe(true);
    expect(isAuthPath("/signup")).toBe(true);
    expect(isAuthPath("/verify")).toBe(true);
    expect(isAuthPath("/forgot-password")).toBe(true);
    expect(isAuthPath("/reset-password")).toBe(true);
    expect(isAuthPath("/reset-password/anything")).toBe(true);
  });

  it("does not match protected or onboarding paths", () => {
    expect(isAuthPath("/")).toBe(false);
    expect(isAuthPath("/communities")).toBe(false);
    expect(isAuthPath("/welcome")).toBe(false);
    expect(isAuthPath("/setup")).toBe(false);
    expect(isAuthPath("/auth/callback")).toBe(false);
  });
});

describe("isOnboardingPath", () => {
  it("matches /welcome and /setup (and their descendants)", () => {
    expect(isOnboardingPath("/welcome")).toBe(true);
    expect(isOnboardingPath("/setup")).toBe(true);
    expect(isOnboardingPath("/setup/type")).toBe(true);
    expect(isOnboardingPath("/setup/create")).toBe(true);
  });

  it("does not match the rest of the app", () => {
    expect(isOnboardingPath("/")).toBe(false);
    expect(isOnboardingPath("/login")).toBe(false);
    expect(isOnboardingPath("/communities")).toBe(false);
    expect(isOnboardingPath("/c/slug")).toBe(false);
  });
});

describe("isPublicCollectionPath", () => {
  it("accepts exactly two segments whose first segment is not an app route", () => {
    expect(isPublicCollectionPath("/my-community/my-collection")).toBe(true);
    expect(isPublicCollectionPath("/lagos-alumni/annual-dues")).toBe(true);
  });

  it("rejects paths that collide with app segments", () => {
    expect(isPublicCollectionPath("/c/my-community")).toBe(false);
    expect(isPublicCollectionPath("/communities/anything")).toBe(false);
    expect(isPublicCollectionPath("/login/anything")).toBe(false);
    expect(isPublicCollectionPath("/accept-invite/token")).toBe(false);
    expect(isPublicCollectionPath("/auth/callback")).toBe(false);
    expect(isPublicCollectionPath("/notifications/42")).toBe(false);
    expect(isPublicCollectionPath("/account/profile")).toBe(false);
  });

  it("rejects fewer or more than two segments", () => {
    expect(isPublicCollectionPath("/")).toBe(false);
    expect(isPublicCollectionPath("/one")).toBe(false);
    expect(isPublicCollectionPath("/one/two/three")).toBe(false);
  });
});

describe("redirectWithRefreshedCookies", () => {
  type CookieOptions = NonNullable<Parameters<NextResponse["cookies"]["set"]>[2]>;
  function makeSource(cookies: Array<{ name: string; value: string; options?: CookieOptions }>): NextResponse {
    const response = NextResponse.next();
    for (const { name, value, options } of cookies) {
      if (options) response.cookies.set(name, value, options);
      else response.cookies.set(name, value);
    }
    return response;
  }

  it("creates a 307 redirect to the destination (NextResponse.redirect default)", () => {
    const source = makeSource([]);
    const redirect = redirectWithRefreshedCookies(source, new URL("http://localhost:3000/login"));
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe("http://localhost:3000/login");
  });

  it("copies refreshed session cookies with their values and options", () => {
    const source = makeSource([
      {
        name: "sb-abc-auth-token",
        value: "eyJhbGciOi.payload.sig",
        options: { httpOnly: true, path: "/", sameSite: "lax", maxAge: 3600 },
      },
      {
        name: "sb-abc-auth-token-code-verifier",
        value: "verifier-value",
        options: { httpOnly: true, path: "/", sameSite: "lax" },
      },
    ]);

    const redirect = redirectWithRefreshedCookies(source, new URL("http://localhost:3000/welcome"));

    const authToken = redirect.cookies.get("sb-abc-auth-token");
    expect(authToken?.value).toBe("eyJhbGciOi.payload.sig");
    expect(authToken?.httpOnly).toBe(true);
    expect(authToken?.path).toBe("/");
    expect(authToken?.sameSite).toBe("lax");
    expect(authToken?.maxAge).toBe(3600);

    const verifier = redirect.cookies.get("sb-abc-auth-token-code-verifier");
    expect(verifier?.value).toBe("verifier-value");
    expect(verifier?.httpOnly).toBe(true);
  });

  it("has no cookies when the source carries none (no spurious Set-Cookie)", () => {
    const source = makeSource([]);
    const redirect = redirectWithRefreshedCookies(source, new URL("http://localhost:3000/communities"));
    expect(redirect.cookies.getAll()).toHaveLength(0);
  });

  it("preserves a chunked session (@supabase/ssr splits long tokens into .0/.1)", () => {
    const source = makeSource([
      { name: "sb-abc-auth-token.0", value: "part0", options: { path: "/", httpOnly: true } },
      { name: "sb-abc-auth-token.1", value: "part1", options: { path: "/", httpOnly: true } },
    ]);
    const redirect = redirectWithRefreshedCookies(source, new URL("http://localhost:3000/welcome"));
    expect(redirect.cookies.get("sb-abc-auth-token.0")?.value).toBe("part0");
    expect(redirect.cookies.get("sb-abc-auth-token.1")?.value).toBe("part1");
  });
});
