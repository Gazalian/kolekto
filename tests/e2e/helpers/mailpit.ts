/**
 * mailpit.ts — reads the OTP code the local stack actually sent, from
 * Mailpit's REST API (`MAILPIT_URL`, `supabase status`), instead of mocking
 * `supabase.auth` away. A test that never exercises the real OTP email is not
 * testing the auth flow the brief asks for; it is testing that a mock returns
 * what it was told to return.
 */

const MAILPIT_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";

interface MailpitMessageSummary {
  ID: string;
  To: { Address: string }[];
}

/** Polls Mailpit for the newest message to `address` and extracts its 6-digit code. Supabase's default OTP template names the token in plain text, which is what makes a regex reliable here — it is not parsing a fragile HTML structure. */
export async function readOtpCode(address: string, { timeoutMs = 15_000 }: { timeoutMs?: number } = {}): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const listResponse = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=25`);
    const { messages } = (await listResponse.json()) as { messages: MailpitMessageSummary[] };
    const match = messages.find((m) => m.To.some((to) => to.Address.toLowerCase() === address.toLowerCase()));

    if (match) {
      const messageResponse = await fetch(`${MAILPIT_URL}/api/v1/message/${match.ID}`);
      const message = (await messageResponse.json()) as { Text: string };
      const code = /\b(\d{6})\b/.exec(message.Text)?.[1];
      if (code) return code;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`No OTP email arrived for ${address} within ${timeoutMs}ms`);
}
