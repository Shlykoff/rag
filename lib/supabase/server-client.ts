// lib/supabase/server-client.ts
//
// Session-aware Supabase client for Route Handlers / Server Actions, using
// the anon key + the caller's own auth cookies (standard `@supabase/ssr`
// pattern for Next.js App Router). This is how app/api/chat/route.ts
// authenticates the request and obtains a *validated* user id -- it must
// never trust a `userId`/`p_user_id` sent in the request body, per
// CLAUDE.md and the match_document_chunks RPC's security comment.
//
// This client is intentionally separate from
// lib/supabase/service-client.ts: this one is subject to RLS (it acts as
// the signed-in user, via `authenticated` role), the service-role client is
// not. Retrieval/rate-limiting/ingestion still use the service-role client
// for their actual reads/writes (see those modules' own comments for why),
// but only ever with a user id that came from *this* client's session.

import "server-only";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient, User } from "@supabase/supabase-js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}. See .env.example.`);
  }
  return value;
}

/**
 * Builds a request-scoped Supabase client bound to the current Route
 * Handler's cookies. Must be called fresh per-request (cookies() is
 * request-scoped in the App Router) -- do not memoize this the way
 * lib/ai/index.ts or lib/supabase/service-client.ts memoize theirs.
 */
export async function getRouteHandlerSupabaseClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Route Handlers can only set cookies in specific response
          // contexts; a write here that isn't allowed (e.g. called from a
          // context that can't mutate the response) is safe to ignore --
          // the auth session itself is unaffected, only token refresh
          // persistence would be, and that's retried on the next request.
        }
      },
    },
  });
}

export interface AuthenticatedUser {
  id: string;
  email: string | null;
}

/**
 * Resolves the current request's authenticated user from the validated
 * session cookie, or returns null if there isn't one. Uses
 * `supabase.auth.getUser()` (not `getSession()`), which per Supabase's own
 * guidance revalidates the JWT against the auth server rather than trusting
 * a locally-decoded cookie -- the right call for something that gates
 * server-side data access (rate limiting, retrieval, chat).
 */
export async function getAuthenticatedUser(
  supabase: SupabaseClient
): Promise<AuthenticatedUser | null> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return toAuthenticatedUser(data.user);
}

function toAuthenticatedUser(user: User): AuthenticatedUser {
  return { id: user.id, email: user.email ?? null };
}

/**
 * Verifies that `projectId` is visible to the CURRENT session on `supabase`
 * (i.e. this MUST be an RLS-scoped client from getRouteHandlerSupabaseClient()
 * above, never the service-role client) -- relies entirely on the
 * `projects_select_own` RLS policy (`auth.uid() = user_id`, see the
 * projects migration) to do the actual ownership check: a project that
 * doesn't exist and a project that exists but belongs to someone else are
 * indistinguishable here (both resolve `data: null`), which is exactly
 * what callers want -- see their own 404-not-403 comments.
 *
 * This is the projects-pivot generalization of the "own vs. someone else's
 * row, respond identically" pattern already used by
 * app/api/sources/[documentId]/route.ts, which routes its own ownership
 * check through this exact helper (via app/api/sources/shared.ts's
 * loadOwnedDocument()). Every route that accepts a projectId (directly, or
 * derived from a document/conversation row) MUST call this -- or an
 * equivalent RLS-backed check -- before ever passing that projectId into a
 * service-role call (lib/ai/, lib/retrieval/, lib/rate-limit/,
 * lib/ingestion/), per the match_document_chunks RPC's own security
 * comment: those service-role paths trust their caller completely and do
 * not re-derive ownership from RLS themselves.
 */
export async function verifyProjectOwnership(supabase: SupabaseClient, projectId: string): Promise<boolean> {
  const { data, error } = await supabase.from("projects").select("id").eq("id", projectId).maybeSingle();
  if (error) {
    throw new Error(`verifyProjectOwnership: failed to verify project ${projectId}: ${error.message}`);
  }
  return data !== null;
}
