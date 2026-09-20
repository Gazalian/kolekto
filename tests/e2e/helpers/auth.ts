import { expect, type Page } from "@playwright/test";
import { readOtpCode } from "./mailpit.ts";

/**
 * Signs in a brand-new person through the real OTP flow, retrying the send once
 * if the local stack stalls.
 *
 * The retry is for a measured local-stack failure, not for a flaky assertion.
 * Under the load of a full suite run on a machine also hosting the Supabase
 * containers, `POST /auth/v1/otp` intermittently exceeds Kong's upstream
 * timeout and comes back 504 ("Processing this request timed out, please retry
 * after a moment"), while the same request — same headers, same PKCE body —
 * answers in about a second from curl, and from a browser when the machine is
 * quiet. The application is not involved: the request never reaches it.
 *
 * Each attempt uses a NEW address, because GoTrue's SMTP_MAX_FREQUENCY (60s,
 * supabase/config.toml) rejects a second send to the same one — a retry that
 * reused the address would turn one environmental failure into a guaranteed
 * second one.
 *
 * Returns the address that signed in, for a test that needs to assert on it.
 */
export async function signInAsNewUser(page: Page, prefix = "e2e"): Promise<string> {
  await page.goto("/login");
  // Without this, a click can land before the page finishes hydrating and falls
  // through to the <form>'s native GET submission instead of React's onSubmit
  // handler — observed directly against this build; Next.js gives no other DOM
  // signal that hydration has completed.
  await page.waitForLoadState("networkidle");

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const email = `${prefix}-${Date.now()}-${attempt}@example.test`;

    await page.getByLabel("Email address").fill(email);
    await page.getByRole("button", { name: "Send code" }).click();

    try {
      await page.getByText(email).waitFor({ timeout: 30_000 });
    } catch {
      if (attempt === 2) {
        throw new Error("The local stack did not accept a sign-in request after two attempts");
      }
      continue;
    }

    const code = await readOtpCode(email);
    await page.getByLabel("6-digit code").fill(code);
    await page.getByRole("button", { name: "Verify and sign in" }).click();

    await expect(page).toHaveURL(/\/communities/);
    return email;
  }

  throw new Error("unreachable");
}
