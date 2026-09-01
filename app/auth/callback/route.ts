// app/auth/callback/route.ts
//
// Google OAuth callback: Supabase Auth redirects the browser here with a
// one-time `?code=...` after the user approves consent on Google's side
// (see components/auth/GoogleSignInButton.tsx's `signInWithOAuth` call).
// Exchanges that code for a real session via `@supabase/ssr`'s
// `exchangeCodeForSession()`, through `getRouteHandlerSupabaseClient()` --
// the same cookie-writing client every other Route Handler here uses.
// Its cookie adapter calls `next/headers`'s `cookies().set()`, which --
// unlike in a Server Component render -- Next.js does attach to whatever
// Response this handler returns, including a plain
// `NextResponse.redirect(...)`; no manual `response.cookies.set()`
// plumbing is needed here.
//
// Excluded from proxy.ts's auth gate on purpose -- this route runs with no
// session at all on the very first hit, by design.
//
// Open-redirect protection: the only redirect destination this route ever
// produces is one of a fixed, hardcoded allow-list of in-app paths, never
// the raw `next` query param or a full external URL.
//
// First-ever Google sign-in: a brand-new auth.users row has no projects/
// ai_provider_credentials rows yet. Nothing here or on any page this can
// redirect to assumes those exist -- "/" itself redirects to "/projects",
// whose empty state already treats "zero projects yet" as normal.

import "server-only";
import { NextResponse } from "next/server";
import { getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED_REDIRECT_PATHS = new Set<string>(["/", "/projects", "/profile"]);

/** Never returns anything but one of ALLOWED_REDIRECT_PATHS's exact values -- see the module comment above. */
function resolveRedirectTarget(nextParam: string | null): string {
  if (nextParam && ALLOWED_REDIRECT_PATHS.has(nextParam)) return nextParam;
  return "/";
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const target = resolveRedirectTarget(url.searchParams.get("next"));

  if (!code) {
    // No code -- either a stray GET, or Google/Supabase reported a failure
    // via ?error=...&error_description=... (e.g. user declined consent).
    // Nothing to exchange; bounce to /login rather than throwing.
    return NextResponse.redirect(new URL("/login", url.origin));
  }

  const supabase = await getRouteHandlerSupabaseClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    console.error("app/auth/callback/route.ts: exchangeCodeForSession failed:", error.message);
    return NextResponse.redirect(new URL("/login", url.origin));
  }

  return NextResponse.redirect(new URL(target, url.origin));
}
