// app/api/projects/__tests__/route.integration.test.ts
//
// POST/GET /api/projects against a REAL local Supabase: a new project gets
// its models pre-filled when the owner's keys leave only one choice, and
// the DTO's chat model name comes from the real catalog embed. Auth
// resolution is mocked; everything else is real.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestUser,
  deleteTestUser,
  hasIntegrationEnv,
  makeIntegrationSupabaseClient,
} from "../../../../lib/testing/integration-helpers";
import { findCatalogModel } from "../../../../lib/testing/ai-model-fixtures";

let currentUser: { id: string; email: string } | null = null;

vi.mock("@/lib/supabase/server-client", () => ({
  getRouteHandlerSupabaseClient: async () => ({}),
  getAuthenticatedUser: async () => currentUser,
}));

import { GET, POST } from "../route";
import { listAIModels, saveAIProviderCredential, type AIModel, type AIProviderCredentialType } from "@/lib/ai";

function createRequest(name: string): Request {
  return new Request("http://localhost/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

describe.skipIf(!hasIntegrationEnv() || !process.env.CREDENTIALS_ENCRYPTION_KEY)(
  "POST/GET /api/projects (integration, real Supabase)",
  () => {
    let supabase: SupabaseClient;
    let catalog: AIModel[];
    const createdUsers: string[] = [];

    beforeAll(async () => {
      supabase = makeIntegrationSupabaseClient();
      catalog = await listAIModels(supabase);
    });

    afterAll(async () => {
      for (const id of createdUsers) await deleteTestUser(supabase, id);
    });

    afterEach(() => {
      currentUser = null;
    });

    async function signInWithKeys(label: string, keys: AIProviderCredentialType[]): Promise<string> {
      const user = await createTestUser(supabase, label);
      createdUsers.push(user.id);
      for (const provider of keys) {
        await saveAIProviderCredential(supabase, user.id, provider, `fake-${provider}-${user.id}`);
      }
      currentUser = user;
      return user.id;
    }

    it("Anthropic + Voyage keys: the new project starts on Claude + Voyage, and GET shows the model name", async () => {
      await signInWithKeys("projects-create-claude", ["anthropic", "voyage"]);
      const opus = findCatalogModel(catalog, "claude-opus-5");
      const voyage = findCatalogModel(catalog, "voyage-4-large");

      const response = await POST(createRequest("Claude bot"));

      expect(response.status).toBe(201);
      const { project } = await response.json();
      expect(project).toMatchObject({
        name: "Claude bot",
        activeAiProvider: "anthropic",
        chatModelId: opus.id,
        chatModelName: "Claude Opus 5",
        embeddingModelId: voyage.id,
        documentCount: 0,
      });

      const { data: row } = await supabase
        .from("projects")
        .select("active_ai_provider, embedding_provider")
        .eq("id", project.id)
        .single();
      expect(row).toEqual({ active_ai_provider: "anthropic", embedding_provider: "voyage" });

      const listed = await (await GET()).json();
      expect(listed.projects).toEqual([project]);
    });

    it("OpenAI + Gemini keys: both slots are ambiguous, so the project starts without models", async () => {
      await signInWithKeys("projects-create-ambiguous", ["openai", "gemini"]);

      const { project } = await (await POST(createRequest("Undecided"))).json();

      expect(project).toMatchObject({ activeAiProvider: null, chatModelId: null, chatModelName: null, embeddingModelId: null });
    });

    it("no keys: no models", async () => {
      await signInWithKeys("projects-create-no-keys", []);

      const { project } = await (await POST(createRequest("Empty"))).json();

      expect(project).toMatchObject({ chatModelId: null, embeddingModelId: null });
    });
  }
);
