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

// Next.js/Turbopack only inlines `NEXT_PUBLIC_*` env vars into the client
// bundle when it can statically see the literal `process.env.NEXT_PUBLIC_X`
// expression in the source -- a dynamic `process.env[name]` lookup (which
// works fine server-side, where `process.env` is the real environment) is
// invisible to that static replacement and evaluates to `undefined` in the
// browser. Both values must therefore be read as literal property accesses
// here, not through a shared `requireEnv(name)` helper.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let cached: SupabaseClient | undefined;

/**
 * Returns a singleton browser Supabase client. Safe to call repeatedly
 * from client components/effects -- `createBrowserClient` itself is cheap,
 * but memoizing avoids creating a fresh auth listener on every render.
 */
export function getBrowserSupabaseClient(): SupabaseClient {
  if (!supabaseUrl) {
    throw new Error("Missing required env var NEXT_PUBLIC_SUPABASE_URL. See .env.example.");
  }
  if (!supabaseAnonKey) {
    throw new Error("Missing required env var NEXT_PUBLIC_SUPABASE_ANON_KEY. See .env.example.");
  }
  if (!cached) {
    cached = createBrowserClient(supabaseUrl, supabaseAnonKey);
  }
  return cached;
}
