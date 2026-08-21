// app/api/projects/[projectId]/__tests__/route.integration.test.ts
//
// Runs against a REAL local Supabase (see README "Running the integration
// tests" / `npm run test:integration`). Two things the mocked unit test
// (../route.test.ts) can only assert "should work" for, verified live
// here instead:
//
//   1. Ownership enforcement is REAL Postgres RLS, not just a mock told to
//      return false: two real signed-in users (lib/testing/integration-
//      helpers.ts's createAuthenticatedTestUser, same pattern
//      supabase/__tests__/projects-pivot-rls.integration.test.ts already
//      established for this table) -- `verifyProjectOwnership` itself is
//      NOT mocked here, only auth resolution is, so
//      `projects_select_own`'s `auth.uid() = user_id` policy is what
//      actually produces the 404 below.
//   2. DELETE's Storage cleanup actually removes objects from the real
//      "documents" bucket -- not just that the `projects` row is gone.
//      Deliberately uploads real objects with NO corresponding `documents`
//      row at all, to prove the route's list()+remove() sweep really does
//      discover objects straight from Storage (per its own header
//      comment) rather than silently depending on the `documents` table
//      it's about to cascade-delete anyway.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createAuthenticatedTestUser,
  createTestProject,
  deleteTestUser,
  hasIntegrationEnv,
  makeIntegrationSupabaseClient,
} from "../../../../../lib/testing/integration-helpers";

let currentUser: { id: string; email: string } | null = null;
let currentAuthClient: SupabaseClient;

vi.mock("@/lib/supabase/server-client", async () => {
  const actual = await vi.importActual<typeof import("../../../../../lib/supabase/server-client")>(
    "../../../../../lib/supabase/server-client"
  );
  return {
    getRouteHandlerSupabaseClient: async () => currentAuthClient,
    getAuthenticatedUser: async () => currentUser,
    verifyProjectOwnership: actual.verifyProjectOwnership,
  };
});

// NOT mocked: lib/supabase/service-client.ts's getServiceRoleClient() talks
// to the real local Supabase started by `supabase start`, via
// NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY loaded from
// .env.local by `npm run test:integration`'s --env-file flag.
import { GET, PATCH, DELETE } from "../route";

function makeRequest(method: string, body?: unknown): Request {
  return new Request("http://localhost/api/projects/x", {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function makeParams(projectId: string): { params: Promise<{ projectId: string }> } {
  return { params: Promise.resolve({ projectId }) };
}

describe.skipIf(!hasIntegrationEnv())("GET/PATCH/DELETE /api/projects/{projectId} (integration, real Supabase)", () => {
  let serviceClient: SupabaseClient;
  let ownerA: { id: string; email: string; client: SupabaseClient };
  let ownerB: { id: string; email: string; client: SupabaseClient };

  beforeAll(async () => {
    serviceClient = makeIntegrationSupabaseClient();
    ownerA = await createAuthenticatedTestUser(serviceClient, "projects-route-owner-a");
    ownerB = await createAuthenticatedTestUser(serviceClient, "projects-route-owner-b");
  });

  afterAll(async () => {
    if (ownerA) await deleteTestUser(serviceClient, ownerA.id);
    if (ownerB) await deleteTestUser(serviceClient, ownerB.id);
  });

  afterEach(() => {
    currentUser = null;
  });

  it("a real second user gets 404 (not 403) on GET/PATCH/DELETE for a project they don't own, and nothing is changed", async () => {
    const project = await createTestProject(serviceClient, ownerA.id, "Owner A's project");

    currentAuthClient = ownerB.client;
    currentUser = { id: ownerB.id, email: ownerB.email };

    const getResponse = await GET(makeRequest("GET"), makeParams(project.id));
    expect(getResponse.status).toBe(404);

    const patchResponse = await PATCH(makeRequest("PATCH", { name: "hijacked" }), makeParams(project.id));
    expect(patchResponse.status).toBe(404);

    const deleteResponse = await DELETE(makeRequest("DELETE"), makeParams(project.id));
    expect(deleteResponse.status).toBe(404);

    // Untouched: still exists, still owned by A, still its original name.
    const { data: stillThere } = await serviceClient.from("projects").select("id, name, user_id").eq("id", project.id).maybeSingle();
    expect(stillThere).toEqual({ id: project.id, name: "Owner A's project", user_id: ownerA.id });
  });

  it("the real owner can GET and PATCH (rename) their own project", async () => {
    const project = await createTestProject(serviceClient, ownerA.id, "Original name");
    currentAuthClient = ownerA.client;
    currentUser = { id: ownerA.id, email: ownerA.email };

    const getResponse = await GET(makeRequest("GET"), makeParams(project.id));
    expect(getResponse.status).toBe(200);
    expect((await getResponse.json()).project).toMatchObject({ id: project.id, name: "Original name", documentCount: 0 });

    const patchResponse = await PATCH(makeRequest("PATCH", { name: "Renamed" }), makeParams(project.id));
    expect(patchResponse.status).toBe(200);
    expect((await patchResponse.json()).project).toMatchObject({ id: project.id, name: "Renamed" });

    const { data: row } = await serviceClient.from("projects").select("name").eq("id", project.id).maybeSingle();
    expect(row?.name).toBe("Renamed");
  });

  it("DELETE actually removes Storage objects under the project's prefix, live -- including ones with no corresponding documents row at all", async () => {
    const project = await createTestProject(serviceClient, ownerA.id, "To be deleted");
    currentAuthClient = ownerA.client;
    currentUser = { id: ownerA.id, email: ownerA.email };

    // Two real objects under "<projectId>/<fakeDocumentId>/<suffix>" --
    // deliberately with NO `documents` row pointing at either, so this
    // proves the cleanup is a genuine Storage list()+remove() sweep, not
    // secretly derived from the documents table (see this file's header).
    const fakeDocId1 = randomUUID();
    const fakeDocId2 = randomUUID();
    const path1 = `${project.id}/${fakeDocId1}/content.txt`;
    const path2 = `${project.id}/${fakeDocId2}/original.pdf`;
    const upload1 = await serviceClient.storage.from("documents").upload(path1, Buffer.from("hello world"), { contentType: "text/plain" });
    const upload2 = await serviceClient.storage.from("documents").upload(path2, Buffer.from("%PDF-fake"), { contentType: "application/pdf" });
    expect(upload1.error).toBeNull();
    expect(upload2.error).toBeNull();

    try {
      const response = await DELETE(makeRequest("DELETE"), makeParams(project.id));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ projectId: project.id, status: "deleted" });

      // The project row (and, via cascade, anything under it) is gone.
      const { data: projectRow } = await serviceClient.from("projects").select("id").eq("id", project.id);
      expect(projectRow).toEqual([]);

      // The whole "<projectId>/" prefix is empty -- both objects are
      // genuinely gone from Storage, not just their (nonexistent) DB rows.
      const { data: remaining, error: listError } = await serviceClient.storage.from("documents").list(project.id);
      expect(listError).toBeNull();
      expect(remaining).toEqual([]);

      // Fetching either object directly also confirms removal (list() on
      // an empty prefix could theoretically be ambiguous between "empty
      // folder" and "never existed" -- a direct download attempt is
      // unambiguous: NotFound).
      const download1 = await serviceClient.storage.from("documents").download(path1);
      expect(download1.error).not.toBeNull();
    } finally {
      // Safety net only -- the assertions above already prove the route
      // itself removed both objects; this just guards against a failed
      // assertion above leaving real objects behind in local Storage.
      await serviceClient.storage.from("documents").remove([path1, path2]);
    }
  });

  it("DELETE with zero Storage objects still succeeds (no remove() call needed)", async () => {
    const project = await createTestProject(serviceClient, ownerA.id, "Empty project");
    currentAuthClient = ownerA.client;
    currentUser = { id: ownerA.id, email: ownerA.email };

    const response = await DELETE(makeRequest("DELETE"), makeParams(project.id));
    expect(response.status).toBe(200);
  });
});
