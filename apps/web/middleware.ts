import type { NextRequest } from "next/server";
import { updateSession } from "./lib/supabase/middleware.ts";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Exclude /api/webhooks/* so inbound provider webhooks (M13.2 P9-2 SES/SNS
  // ingestion) are not routed through session-refresh middleware: a webhook
  // carries no Supabase cookie and the middleware would otherwise redirect
  // the request to /login, breaking signature-authenticated ingestion.
  matcher: ["/((?!api/webhooks|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
