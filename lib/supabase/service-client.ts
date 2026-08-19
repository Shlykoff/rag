// lib/supabase/service-client.ts
//
// The ONLY place in this project that should construct a Supabase client
// with SUPABASE_SERVICE_ROLE_KEY. This key bypasses RLS entirely (CLAUDE.md
// rule 2: "используется только в server-side коде... никогда не передаётся
// в клиентский бандл"), so:
//   - This file must never be imported from a Client Component or anything
//     bundled for the browser (there's no "use client" guard that can
//     enforce this at the type level -- Next.js's server-only convention is
//     the enforcement mechanism; see the `server-only` import below).
//   - Every call site (lib/retrieval/search.ts, lib/ingestion/ingest.ts,
//     lib/rate-limit/*, app/api/chat/route.ts) must pass a p_user_id/user_id
//     that came from a validated server-side session
//     (lib/supabase/server-client.ts), never from a client-supplied
//     parameter -- this client has no RLS backstop if that rule is broken.

import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | undefined;

export function getServiceRoleClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars. See .env.example."
    );
  }

  cached = createClient(url, serviceRoleKey, {
    auth: {
      // This client is never used to sign users in/out or persist a
      // session -- it authenticates as service_role via the key itself.
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  return cached;
}
