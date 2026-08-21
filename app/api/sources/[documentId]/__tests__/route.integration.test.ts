// app/api/sources/[documentId]/__tests__/route.integration.test.ts
//
// Regression test for the qa-reviewer-found race: two DELETEs for the SAME
// document, fired truly concurrently (Promise.all, not sequentially),
// against a REAL local Supabase (Postgres + PostgREST) -- see README
// "Running the integration tests" / `npm run test:integration`.
//
// Why this needs real Postgres and can't be proven with a mock: the bug is
// specifically that `DELETE ... WHERE id = X AND user_id = Y` matching ZERO
// rows is, per PostgREST, NOT an error (`error: null`) -- the row count is
// only observable via `.select()`'s returned array length. A mock can be
// *told* to return that shape (see route.test.ts's "lost the race" unit
// test), but only a real DB, with two requests actually racing each other
// through Postgres's row-locking, proves the two requests really do
// serialize such that exactly one of them is the one whose DELETE affects
// the row and the other's affects zero -- that ordering guarantee is
// Postgres's, not something a mock can demonstrate.
//
// The auth layer is mocked (this file calls the route handler function
// directly, not over HTTP -- same reasoning as
// lib/sources/__tests__/manual-upload.integration.test.ts's header comment:
// no HTTP server harness in this project's test setup) so the test can
// assert on a stable authenticated user without going through the full
// cookie-based session flow. `getRouteHandlerSupabaseClient()` is mocked to
// return the REAL service-role client (not `{}`) so
// `verifyProjectOwnership()` -- which is NOT mocked, it's the real
// implementation from lib/supabase/server-client.ts -- can run a real query
// against real Postgres. This works even though a service-role client
// bypasses RLS (unlike the RLS-scoped session client a real browser session
// would use): the query still correctly returns "no row" for a project
// this test's `userId` doesn't own, because every project inserted below
// is genuinely owned by `userId` -- there's no cross-user case to
// misrepresent in this file. lib/supabase/service-client.ts itself (and the
// real Postgres/PostgREST it talks to) is NOT mocked either -- that's the
// whole point of this suite.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestProject,
  createTestUser,
  deleteTestUser,
  hasIntegrationEnv,
  makeIntegrationSupabaseClient,
} from "../../../../../lib/testing/integration-helpers";

let currentUser: { id: string; email: string } | null = null;
let sharedSupabase: SupabaseClient;

vi.mock("@/lib/supabase/server-client", async () => {
  const actual = await vi.importActual<typeof import("../../../../../lib/supabase/server-client")>(
    "../../../../../lib/supabase/server-client"
  );
  return {
    getRouteHandlerSupabaseClient: async () => sharedSupabase,
    getAuthenticatedUser: async () => currentUser,
    verifyProjectOwnership: actual.verifyProjectOwnership,
  };
});

// NOT mocked: lib/supabase/service-client.ts's getServiceRoleClient() reads
// NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY straight from
// process.env (loaded from .env.local by `npm run test:integration`'s
// --env-file flag) and talks to the real local Supabase started by
// `supabase start`. Static import (not a dynamic one) is safe here despite
// coming after the vi.mock call above -- Vitest hoists vi.mock calls to the
// top of the module before any imports run, same pattern as
// app/api/chat/__tests__/route.test.ts.
import { DELETE } from "../route";

function makeRequest(documentId: string): Request {
  return new Request(`http://localhost/api/sources/${documentId}`, { method: "DELETE" });
}

function makeParams(documentId: string): { params: Promise<{ documentId: string }> } {
  return { params: Promise.resolve({ documentId }) };
}

describe.skipIf(!hasIntegrationEnv())("DELETE /api/sources/{documentId} (integration, real Supabase)", () => {
  let supabase: SupabaseClient;
  let userId: string;
  let projectId: string;

  beforeAll(async () => {
    supabase = makeIntegrationSupabaseClient();
    sharedSupabase = supabase;
    const user = await createTestUser(supabase, "delete-race");
    userId = user.id;
    currentUser = user;
    projectId = (await createTestProject(supabase, userId)).id;
  });

  afterAll(async () => {
    if (userId) await deleteTestUser(supabase, userId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function insertDocument(): Promise<string> {
    const { data, error } = await supabase
      .from("documents")
      .insert({ project_id: projectId, title: "race test doc", source_type: "manual_upload", source_ref: null, processing_status: "ready" })
      .select("id")
      .single();
    if (error || !data) throw new Error(`insertDocument failed: ${error?.message}`);
    return data.id as string;
  }

  it("two concurrent DELETEs for the same document give exactly one 200 and one 404, never 200+200", async () => {
    const documentId = await insertDocument();

    // The bug this reproduces: without the `.select("id")` +
    // zero-rows-affected check in route.ts, BOTH of these would resolve
    // 200 -- the ownership SELECT passes for both before either reaches the
    // DB delete, and a delete matching zero rows was (before the fix)
    // indistinguishable from a delete matching one row.
    const [responseA, responseB] = await Promise.all([
      DELETE(makeRequest(documentId), makeParams(documentId)),
      DELETE(makeRequest(documentId), makeParams(documentId)),
    ]);

    const statuses = [responseA.status, responseB.status].sort();
    expect(statuses).toEqual([200, 404]);

    const bodies = await Promise.all([responseA.json(), responseB.json()]);
    const winner = responseA.status === 200 ? bodies[0] : bodies[1];
    const loser = responseA.status === 200 ? bodies[1] : bodies[0];
    expect(winner).toEqual({ documentId, status: "deleted" });
    expect(loser).toEqual({ error: "not_found" });

    // And the row is actually gone -- not left in a half-deleted state.
    const { data: remaining, error: selectError } = await supabase.from("documents").select("id").eq("id", documentId);
    if (selectError) throw new Error(selectError.message);
    expect(remaining).toHaveLength(0);
  });

  it("a second, SEQUENTIAL delete of an already-deleted document still returns 404 (sanity check, not the race itself)", async () => {
    const documentId = await insertDocument();

    const first = await DELETE(makeRequest(documentId), makeParams(documentId));
    expect(first.status).toBe(200);

    const second = await DELETE(makeRequest(documentId), makeParams(documentId));
    expect(second.status).toBe(404);
    expect(await second.json()).toEqual({ error: "not_found" });
  });
});
