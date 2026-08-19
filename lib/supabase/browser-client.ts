// lib/supabase/browser-client.ts
//
// Browser-side Supabase client (standard `@supabase/ssr` pattern for
// Next.js App Router) -- the counterpart to
// lib/supabase/server-client.ts's `getRouteHandlerSupabaseClient()`. Used
// from "use client" components only (the login form, sign-out button):
// `signInWithPassword`/`signOut` here write the session as cookies (via
// `document.cookie`), which `proxy.ts` and every server-side
// `getRouteHandlerSupabaseClient()` call then read on subsequent
// requests -- this is what keeps client-initiated auth and server-side
// session checks in sync without a manual token hand-off.
//
// Intentionally only wraps the anon key (`NEXT_PUBLIC_SUPABASE_ANON_KEY`),
// which is safe to ship to the browser and is itself subject to RLS --
// never the service-role key (see lib/supabase/service-client.ts's own
// comment and CLAUDE.md rule 2).

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}. See .env.example.`);
  }
  return value;
}

let cached: SupabaseClient | undefined;

/**
 * Returns a singleton browser Supabase client. Safe to call repeatedly
 * from client components/effects -- `createBrowserClient` itself is cheap,
 * but memoizing avoids creating a fresh auth listener on every render.
 */
export function getBrowserSupabaseClient(): SupabaseClient {
  if (!cached) {
    cached = createBrowserClient(
      requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
      requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY")
    );
  }
  return cached;
}
