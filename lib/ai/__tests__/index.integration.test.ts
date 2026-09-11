// lib/ai/__tests__/index.integration.test.ts
//
// getAIProviders()/getEmbeddingsProvider() against a REAL local Supabase:
// the adapters are built from the project's seeded catalog rows and the
// owner's stored (fake-value) keys. Only constructs adapters -- no call
// ever reaches a provider.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AIProviderError, getAIProviders, getEmbeddingsProvider } from "../index";
import { listAIModels, type AIModel } from "../catalog";
import { deleteAIProviderCredential, saveAIProviderCredential } from "../credentials";
import { setProjectChatModel, setProjectEmbeddingModel } from "../model-selection";
import { findCatalogModel } from "../../testing/ai-model-fixtures";
import {
  createTestProject,
  createTestUser,
  deleteTestUser,
  hasIntegrationEnv,
  makeIntegrationSupabaseClient,
} from "../../testing/integration-helpers";

describe.skipIf(!hasIntegrationEnv() || !process.env.CREDENTIALS_ENCRYPTION_KEY)(
  "getAIProviders from catalog rows (integration, real Supabase)",
  () => {
    let supabase: SupabaseClient;
    let catalog: AIModel[];
    let userId: string;

    beforeAll(async () => {
      supabase = makeIntegrationSupabaseClient();
      catalog = await listAIModels(supabase);
      userId = (await createTestUser(supabase, "ai-index")).id;
      for (const provider of ["openai", "anthropic", "gemini", "voyage"] as const) {
        await saveAIProviderCredential(supabase, userId, provider, `fake-${provider}-key`);
      }
    });

    afterAll(async () => {
      if (userId) await deleteTestUser(supabase, userId);
    });

    const model = (modelId: string) => findCatalogModel(catalog, modelId);

    async function projectWith(chat: string | null, embedding: string | null): Promise<string> {
      const { id } = await createTestProject(supabase, userId);
      if (chat) await setProjectChatModel(supabase, id, userId, model(chat).id);
      if (embedding) await setProjectEmbeddingModel(supabase, id, userId, model(embedding).id);
      return id;
    }

    it.each([
      ["claude-sonnet-5", "text-embedding-3-large", "anthropic", "openai", 3072],
      ["gpt-5.6-terra", "voyage-4", "openai", "voyage", 1024],
      ["gemini-3.5-flash-lite", "text-embedding-3-small", "gemini", "openai", 1536],
    ])("%s + %s -> %s chat, %s embeddings at %i dims", async (chat, embedding, chatProvider, embeddingProvider, dims) => {
      const projectId = await projectWith(chat, embedding);

      const pair = await getAIProviders({ projectId, ownerUserId: userId }, supabase);

      expect(pair.chatProvider).toMatchObject({ providerName: chatProvider, modelName: chat });
      expect(pair.embeddingsProvider).toMatchObject({ providerName: embeddingProvider, modelName: embedding, dimensions: dims });
    });

    it("getEmbeddingsProvider works without a chat model", async () => {
      const projectId = await projectWith(null, "gemini-embedding-2");

      expect(await getEmbeddingsProvider({ projectId, ownerUserId: userId }, supabase)).toMatchObject({
        providerName: "gemini",
        modelName: "gemini-embedding-2",
        dimensions: 3072,
      });
    });

    it("no models chosen -> no_credentials", async () => {
      const projectId = await projectWith(null, null);

      const err = await getAIProviders({ projectId, ownerUserId: userId }, supabase).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(AIProviderError);
      expect((err as AIProviderError).kind).toBe("no_credentials");
    });

    it("a key deleted after the model was chosen -> no_credentials", async () => {
      const other = await createTestUser(supabase, "ai-index-deleted-key");
      try {
        await saveAIProviderCredential(supabase, other.id, "openai", "fake-openai-key");
        const { id: projectId } = await createTestProject(supabase, other.id);
        await setProjectChatModel(supabase, projectId, other.id, model("gpt-5.6-luna").id);
        await setProjectEmbeddingModel(supabase, projectId, other.id, model("text-embedding-3-small").id);
        await deleteAIProviderCredential(supabase, other.id, "openai");

        const err = await getAIProviders({ projectId, ownerUserId: other.id }, supabase).catch((e: unknown) => e);

        expect((err as AIProviderError).kind).toBe("no_credentials");
      } finally {
        await deleteTestUser(supabase, other.id);
      }
    });
  }
);
