// app/api/projects/[projectId]/model/__tests__/route.integration.test.ts
//
// GET/PUT /api/projects/{projectId}/model against a REAL local Supabase:
// ownership is real Postgres RLS (two signed-in users, verifyProjectOwnership
// not mocked), and selection runs through the real catalog, foreign keys and
// encrypted (fake-value) keys. Nothing is sent to a provider.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createAuthenticatedTestUser,
  createTestProject,
  deleteTestUser,
  hasIntegrationEnv,
  makeIntegrationSupabaseClient,
} from "../../../../../../lib/testing/integration-helpers";
import { findCatalogModel } from "../../../../../../lib/testing/ai-model-fixtures";

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

import { GET, PUT } from "../route";
import { listAIModels, saveAIProviderCredential, type AIModel, type AIProviderCredentialType } from "@/lib/ai";

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
    let catalog: AIModel[];
    const createdUsers: string[] = [];

    beforeAll(async () => {
      serviceClient = makeIntegrationSupabaseClient();
      catalog = await listAIModels(serviceClient);
    });

    afterAll(async () => {
      for (const id of createdUsers) await deleteTestUser(serviceClient, id);
    });

    afterEach(() => {
      currentUser = null;
    });

    const model = (modelId: string) => findCatalogModel(catalog, modelId);

    /** A fresh signed-in owner (keys drive auto-fill, so tests don't share one) with one project. */
    async function signedInOwner(label: string, keys: AIProviderCredentialType[] = []) {
      const owner = await createAuthenticatedTestUser(serviceClient, label);
      createdUsers.push(owner.id);
      for (const provider of keys) {
        await saveAIProviderCredential(serviceClient, owner.id, provider, `fake-${provider}-${owner.id}`);
      }
      currentAuthClient = owner.client;
      currentUser = { id: owner.id, email: owner.email };
      const project = await createTestProject(serviceClient, owner.id);
      return { owner, projectId: project.id };
    }

    async function projectColumns(projectId: string) {
      const { data, error } = await serviceClient
        .from("projects")
        .select("chat_model_id, embedding_model_id, active_ai_provider, embedding_provider")
        .eq("id", projectId)
        .single();
      if (error) throw new Error(error.message);
      return data;
    }

    it("another signed-in user gets 404 (not 403) on GET and PUT, and nothing changes", async () => {
      const { projectId } = await signedInOwner("model-route-owner", ["openai"]);
      const stranger = await createAuthenticatedTestUser(serviceClient, "model-route-stranger");
      createdUsers.push(stranger.id);
      await saveAIProviderCredential(serviceClient, stranger.id, "openai", "fake-openai");
      currentAuthClient = stranger.client;
      currentUser = { id: stranger.id, email: stranger.email };

      expect((await GET(makeRequest("GET"), makeParams(projectId))).status).toBe(404);
      const put = await PUT(makeRequest("PUT", { chatModelId: model("gpt-5.6-luna").id }), makeParams(projectId));
      expect(put.status).toBe(404);

      expect((await projectColumns(projectId)).chat_model_id).toBeNull();
    });

    it("GET auto-fills from a single key and lists the active catalog by sort_order", async () => {
      const { projectId } = await signedInOwner("model-route-autofill", ["gemini"]);

      const response = await GET(makeRequest("GET"), makeParams(projectId));

      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload).toMatchObject({
        chatModelId: model("gemini-3.8-flash").id,
        embeddingModelId: model("gemini-embedding-001").id,
        embeddingLocked: false,
        configured: { openai: false, anthropic: false, gemini: true, voyage: false },
      });
      const active = catalog.filter((m) => m.isActive);
      expect(payload.models.map((m: { id: string }) => m.id)).toEqual(active.map((m) => m.id));
      expect(payload.models.find((m: { modelId: string }) => m.modelId === "text-embedding-3-large")).toMatchObject({
        kind: "embedding",
        dimensions: 3072,
        maxOutputTokens: null,
        outputPriceUsdPerMtok: null,
        isRecommended: false,
        isActive: true,
      });
      expect(await projectColumns(projectId)).toMatchObject({ active_ai_provider: "gemini", embedding_provider: "gemini" });
    });

    it("PUT chat model: 422 without the key, then 200 once it's saved, with GET and the provider column in sync", async () => {
      const { owner, projectId } = await signedInOwner("model-route-chat", ["openai", "gemini"]);
      const opus = model("claude-opus-5");

      const before = await PUT(makeRequest("PUT", { chatModelId: opus.id }), makeParams(projectId));
      expect(before.status).toBe(422);
      expect(await before.json()).toMatchObject({ error: "missing_credentials", provider: "anthropic" });

      await saveAIProviderCredential(serviceClient, owner.id, "anthropic", `fake-anthropic-${owner.id}`);
      const after = await PUT(makeRequest("PUT", { chatModelId: opus.id }), makeParams(projectId));
      expect(after.status).toBe(200);
      expect(await after.json()).toEqual({ chatModelId: opus.id });

      expect((await (await GET(makeRequest("GET"), makeParams(projectId))).json()).chatModelId).toBe(opus.id);
      expect(await projectColumns(projectId)).toMatchObject({ chat_model_id: opus.id, active_ai_provider: "anthropic" });
    });

    it("PUT rejects a wrong-kind model and an unknown id with 400 invalid_model", async () => {
      const { projectId } = await signedInOwner("model-route-invalid", ["openai"]);

      const wrongKind = await PUT(makeRequest("PUT", { chatModelId: model("text-embedding-3-small").id }), makeParams(projectId));
      expect(wrongKind.status).toBe(400);
      expect(await wrongKind.json()).toMatchObject({ error: "invalid_model", reason: "wrong_kind" });

      const unknown = await PUT(
        makeRequest("PUT", { embeddingModelId: "99999999-9999-4999-8999-999999999999" }),
        makeParams(projectId)
      );
      expect(unknown.status).toBe(400);
      expect(await unknown.json()).toMatchObject({ error: "invalid_model", reason: "not_found" });
    });

    it("the embedding model can change while the project is empty, then 409 once it has documents", async () => {
      const { projectId } = await signedInOwner("model-route-lock", ["openai", "gemini"]);

      const first = await PUT(makeRequest("PUT", { embeddingModelId: model("gemini-embedding-001").id }), makeParams(projectId));
      expect(first.status).toBe(200);
      const second = await PUT(makeRequest("PUT", { embeddingModelId: model("text-embedding-3-large").id }), makeParams(projectId));
      expect(second.status).toBe(200);

      const { error: docError } = await serviceClient
        .from("documents")
        .insert({ project_id: projectId, title: "Indexed doc", source_type: "manual_upload" });
      expect(docError).toBeNull();
      expect((await (await GET(makeRequest("GET"), makeParams(projectId))).json()).embeddingLocked).toBe(true);

      const locked = await PUT(makeRequest("PUT", { embeddingModelId: model("gemini-embedding-001").id }), makeParams(projectId));
      expect(locked.status).toBe(409);
      expect((await locked.json()).error).toBe("embedding_locked");
      expect(await projectColumns(projectId)).toMatchObject({
        embedding_model_id: model("text-embedding-3-large").id,
        embedding_provider: "openai",
      });
    });
  }
);
