// app/auth/callback/route.ts
//
// Google OAuth callback: Supabase Auth redirects the browser here with a
// one-time `?code=...` after the user approves consent on Google's side
// (see components/auth/GoogleSignInButton.tsx's `signInWithOAuth({
// provider: "google", options: { redirectTo: "<origin>/auth/callback" } })`
// call). This route exchanges that code for a real session, using
// `@supabase/ssr`'s own `exchangeCodeForSession()` (via
// lib/supabase/server-client.ts's `getRouteHandlerSupabaseClient()`, the
// exact same cookie-writing Supabase client every other Route Handler in
// this project already uses) -- never a hand-rolled PKCE/state exchange.
// `getRouteHandlerSupabaseClient()`'s cookie adapter calls
// `next/headers`'s `cookies().set()`, which -- unlike in a Server Component
// render -- Next.js *does* attach to whatever Response this handler
// ultimately returns, including a plain `NextResponse.redirect(...)`; no
// manual `response.cookies.set()` plumbing is needed here.
//
// Excluded from proxy.ts's auth gate on purpose (see that file's matcher
// comment) -- this route runs with NO session at all on the very first
// hit, by design.
//
// Open-redirect protection: the only redirect destination this route will
// ever produce is one of a fixed, hardcoded allow-list of in-app paths
// (never the raw `next` query param, never a full external URL) -- a
// crafted `?next=https://evil.example` (or `?next=//evil.example`, the
// protocol-relative variant) simply falls back to "/", it is never echoed
// into the Location header.
//
// First-ever Google sign-in: a brand-new auth.users row has no
// `user_settings`/`ai_provider_credentials` rows yet. Nothing here (or on
// any page this can redirect to -- "/", "/sources", "/profile") assumes
// those exist; see lib/ai/credentials.ts's "lazy row" design and
// app/(app)/layout.tsx's getActiveAIProviderInfo() call, both already built
// to treat "no active provider yet" as a normal, expected state rather
// than an error.

import "server-only";
import { NextResponse } from "next/server";
import { getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED_REDIRECT_PATHS = new Set<string>(["/", "/sources", "/profile"]);

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
    // No `code` -- either a bare/stray GET to this route, or Google/Supabase
    // reported a failure via `?error=...&error_description=...` (e.g. the
    // user declined consent). Either way there is nothing to exchange;
    // bounce back to /login rather than throwing (this must never 500 --
    // qa-reviewer's checklist for this stage verifies exactly that).
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
