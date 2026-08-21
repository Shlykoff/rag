// app/api/projects/[projectId]/model/__tests__/route.integration.test.ts
//
// Runs against a REAL local Supabase. Two things the mocked unit test
// (../route.test.ts) can only assert "should work" for, verified live
// here instead:
//   1. Ownership enforcement is REAL Postgres RLS (two real signed-in
//      users, `verifyProjectOwnership` NOT mocked) -- same pattern as
//      ../../__tests__/route.integration.test.ts, applied to this route.
//   2. The full round trip through REAL lib/ai/credentials.ts calls: save
//      a real (fake-value, never sent to an actual provider) API key,
//      encrypt/decrypt it for real, PUT this project's active provider,
//      and read it back via GET -- including the real
//      MissingProviderCredentialsError path when the owner tries to
//      activate a provider they haven't connected a credential for yet.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createAuthenticatedTestUser,
  createTestProject,
  deleteTestUser,
  hasIntegrationEnv,
  makeIntegrationSupabaseClient,
} from "../../../../../../lib/testing/integration-helpers";

let currentUser: { id: string; email: string } | null = null;
let currentAuthClient: SupabaseClient;

vi.mock("@/lib/supabase/server-client", async () => {
  const actual = await vi.importActual<typeof import("../../../../../../lib/supabase/server-client")>(
    "../../../../../../lib/supabase/server-client"
  );
  return {
    getRouteHandlerSupabaseClient: async () => currentAuthClient,
    getAuthenticatedUser: async () => currentUser,
    verifyProjectOwnership: actual.verifyProjectOwnership,
  };
});

// NOT mocked: lib/supabase/service-client.ts and lib/ai/credentials.ts's
// real encrypt/DB calls talk to the real local Supabase started by
// `supabase start` (NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY /
// CREDENTIALS_ENCRYPTION_KEY loaded from .env.local by `npm run
// test:integration`'s --env-file flag).
import { GET, PUT } from "../route";
import { saveAIProviderCredential } from "@/lib/ai";

function makeRequest(method: string, body?: unknown): Request {
  return new Request("http://localhost/api/projects/x/model", {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function makeParams(projectId: string): { params: Promise<{ projectId: string }> } {
  return { params: Promise.resolve({ projectId }) };
}

describe.skipIf(!hasIntegrationEnv() || !process.env.CREDENTIALS_ENCRYPTION_KEY)(
  "GET/PUT /api/projects/{projectId}/model (integration, real Supabase)",
  () => {
    let serviceClient: SupabaseClient;
    let ownerA: { id: string; email: string; client: SupabaseClient };
    let ownerB: { id: string; email: string; client: SupabaseClient };

    beforeAll(async () => {
      serviceClient = makeIntegrationSupabaseClient();
      ownerA = await createAuthenticatedTestUser(serviceClient, "model-route-owner-a");
      ownerB = await createAuthenticatedTestUser(serviceClient, "model-route-owner-b");
    });

    afterAll(async () => {
      if (ownerA) await deleteTestUser(serviceClient, ownerA.id);
      if (ownerB) await deleteTestUser(serviceClient, ownerB.id);
    });

    afterEach(() => {
      currentUser = null;
    });

    it("a real second user gets 404 (not 403) on GET/PUT for a project they don't own", async () => {
      const project = await createTestProject(serviceClient, ownerA.id, "Owner A's project");

      currentAuthClient = ownerB.client;
      currentUser = { id: ownerB.id, email: ownerB.email };

      const getResponse = await GET(makeRequest("GET"), makeParams(project.id));
      expect(getResponse.status).toBe(404);

      const putResponse = await PUT(makeRequest("PUT", { provider: "openai" }), makeParams(project.id));
      expect(putResponse.status).toBe(404);

      // Untouched.
      const { data: row } = await serviceClient.from("projects").select("active_ai_provider").eq("id", project.id).maybeSingle();
      expect(row?.active_ai_provider).toBeNull();
    });

    it("400 { error: 'missing_credentials' } for a provider the owner hasn't connected yet, then a real save + PUT + GET round trip once they have", async () => {
      const project = await createTestProject(serviceClient, ownerA.id, "Model round trip");
      currentAuthClient = ownerA.client;
      currentUser = { id: ownerA.id, email: ownerA.email };

      // Nothing saved yet for this fresh user -- expect a clean 400, not a 500.
      const beforeResponse = await PUT(makeRequest("PUT", { provider: "gemini" }), makeParams(project.id));
      expect(beforeResponse.status).toBe(400);
      const beforeBody = await beforeResponse.json();
      expect(beforeBody).toMatchObject({ error: "missing_credentials", provider: "gemini", missing: ["gemini"] });

      // Real save (fake key value -- never sent to an actual Gemini API by
      // this test, only encrypted/stored/decrypted).
      await saveAIProviderCredential(serviceClient, ownerA.id, "gemini", `AIza-integration-test-${project.id}`);

      const beforeGet = await GET(makeRequest("GET"), makeParams(project.id));
      expect((await beforeGet.json()).configured).toMatchObject({ gemini: true, openai: false });

      const putResponse = await PUT(makeRequest("PUT", { provider: "gemini" }), makeParams(project.id));
      expect(putResponse.status).toBe(200);
      expect(await putResponse.json()).toEqual({ activeProvider: "gemini" });

      const afterGet = await GET(makeRequest("GET"), makeParams(project.id));
      expect(await afterGet.json()).toMatchObject({ activeProvider: "gemini" });

      const { data: row } = await serviceClient.from("projects").select("active_ai_provider").eq("id", project.id).maybeSingle();
      expect(row?.active_ai_provider).toBe("gemini");
    });

    it("anthropic requires BOTH its own key and a voyage key -- missing just voyage still blocks activation with a real 400", async () => {
      const project = await createTestProject(serviceClient, ownerA.id, "Anthropic pairing");
      currentAuthClient = ownerA.client;
      currentUser = { id: ownerA.id, email: ownerA.email };

      await saveAIProviderCredential(serviceClient, ownerA.id, "anthropic", `sk-ant-integration-test-${project.id}`);
      // Deliberately no 'voyage' credential saved for this user.

      const response = await PUT(makeRequest("PUT", { provider: "anthropic" }), makeParams(project.id));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("missing_credentials");
      expect(body.missing).toEqual(["voyage"]);
    });
  }
);
