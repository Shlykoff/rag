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

export async function deleteTestUser(supabase: SupabaseClient, userId: string): Promise<void> {
  // `documents` (and transitively `document_chunks`/`conversations`/
  // `messages`/`usage_events`) all reference auth.users with `on delete
  // cascade`, so deleting the user is enough to clean up everything a test
  // created for it.
  await supabase.auth.admin.deleteUser(userId);
}

/** A deterministic, non-random 1024-dim vector for a given seed -- lets tests assert exact/near similarity without calling a real embeddings API. `mostlyZero` puts a single 1.0 at index `seed % 1024` (nearly orthogonal vectors for different seeds), which is enough to test ranking/isolation without needing semantically meaningful content. 1024 matches document_chunks.embedding vector(1024) -- see CLAUDE.md. */
export function deterministicVector(seed: number, dimensions = 1024): number[] {
  const vector = new Array(dimensions).fill(0);
  vector[seed % dimensions] = 1;
  return vector;
}
