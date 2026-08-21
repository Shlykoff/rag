// lib/testing/integration-helpers.ts
//
// Shared fixtures for the *.integration.test.ts suite (run via `npm run
// test:integration` against a real local Supabase -- see
// vitest.integration.config.mts / README). NOT itself a test file (no
// `.test.ts` suffix), and NOT imported by anything under `npm test`.
//
// Deliberately not using lib/supabase/service-client.ts's memoized
// singleton here: integration tests want a plain, disposable client
// constructed straight from env vars, independent of that module's
// caching behavior (which is a production concern, not a test one).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function requireIntegrationEnv(): { url: string; serviceRoleKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      "Integration tests require NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY -- " +
        "run via `npm run test:integration` (loads .env.local) against a local `supabase start`."
    );
  }
  return { url, serviceRoleKey };
}

export function hasIntegrationEnv(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function makeIntegrationSupabaseClient(): SupabaseClient {
  const { url, serviceRoleKey } = requireIntegrationEnv();
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Same as requireIntegrationEnv, but for the anon key -- needed only by tests that sign in as a real user (createAuthenticatedTestUser below) to exercise actual Postgres RLS enforcement for the `authenticated` role, as opposed to tests that use the service-role client with an explicit filter (which only tests application/RPC logic, not RLS itself). */
export function requireIntegrationAnonEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "RLS integration tests require NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY -- " +
        "run via `npm run test:integration` (loads .env.local) against a local `supabase start`."
    );
  }
  return { url, anonKey };
}

/** Creates a throwaway confirmed auth user for one test, via the admin API (service-role only). Caller is responsible for calling deleteTestUser in an afterAll/afterEach. */
export async function createTestUser(
  supabase: SupabaseClient,
  label: string
): Promise<{ id: string; email: string }> {
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: `test-password-${Math.random().toString(36).slice(2)}`,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`createTestUser: failed to create user: ${error?.message ?? "unknown error"}`);
  }
  return { id: data.user.id, email };
}

/**
 * Creates a throwaway confirmed auth user AND a real signed-in client for
 * it (anon key + password sign-in), so RLS policies get exercised the way
 * Postgres actually enforces them for the `authenticated` role -- not just
 * trusted via an explicit filter on a service-role query (see e.g.
 * lib/retrieval/__tests__/search.integration.test.ts, which tests
 * match_document_chunks' own p_project_id filter, not Postgres RLS
 * itself). Caller is responsible for calling deleteTestUser (via the
 * service-role client) in an afterAll/afterEach.
 */
export async function createAuthenticatedTestUser(
  serviceClient: SupabaseClient,
  label: string
): Promise<{ id: string; email: string; client: SupabaseClient }> {
  const { url, anonKey } = requireIntegrationAnonEnv();
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const password = `test-password-${Math.random().toString(36).slice(2)}`;
  const { data, error } = await serviceClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`createAuthenticatedTestUser: failed to create user: ${error?.message ?? "unknown error"}`);
  }
  const client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) {
    throw new Error(`createAuthenticatedTestUser: failed to sign in as ${email}: ${signInError.message}`);
  }
  return { id: data.user.id, email, client };
}

export async function deleteTestUser(supabase: SupabaseClient, userId: string): Promise<void> {
  // `projects` references auth.users with `on delete cascade`, and
  // `documents`/`conversations`/`usage_events`/`channel_integrations` all
  // reference `projects` the same way (transitively:
  // `document_chunks` -> `documents`, `messages`/external `conversations`
  // rows -> `conversations`, `channel_processed_updates` ->
  // `channel_integrations`) -- so deleting the user cascades through
  // projects and cleans up everything a test created for it in Postgres.
  // It does NOT clean up Supabase Storage objects (Storage isn't a DB
  // foreign key) -- tests that upload real objects must remove() them
  // themselves.
  await supabase.auth.admin.deleteUser(userId);
}

/** A deterministic, non-random 1024-dim vector for a given seed -- lets tests assert exact/near similarity without calling a real embeddings API. `mostlyZero` puts a single 1.0 at index `seed % 1024` (nearly orthogonal vectors for different seeds), which is enough to test ranking/isolation without needing semantically meaningful content. 1024 matches document_chunks.embedding vector(1024) -- see CLAUDE.md. */
export function deterministicVector(seed: number, dimensions = 1024): number[] {
  const vector = new Array(dimensions).fill(0);
  vector[seed % dimensions] = 1;
  return vector;
}
