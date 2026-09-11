// lib/ai/__tests__/model-selection.integration.test.ts
//
// Project model selection and auto-fill against a REAL local Supabase: the
// seeded ai_models catalog, the kind-pinned foreign keys on projects, real
// (fake-value) encrypted keys. Keys are never sent to a provider.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listAIModels, type AIModel } from "../catalog";
import { saveAIProviderCredential, type AIProviderCredentialType } from "../credentials";
import {
  EmbeddingModelLockedError,
  getProjectModelState,
  InvalidModelSelectionError,
  MissingProviderCredentialsError,
  setProjectChatModel,
  setProjectEmbeddingModel,
} from "../model-selection";
import { autoFillProjectModels } from "../model-autofill";
import { findCatalogModel } from "../../testing/ai-model-fixtures";
import {
  createTestProject,
  createTestUser,
  deleteTestUser,
  hasIntegrationEnv,
  makeIntegrationSupabaseClient,
} from "../../testing/integration-helpers";

interface ProjectModelColumns {
  chat_model_id: string | null;
  embedding_model_id: string | null;
  active_ai_provider: string | null;
  embedding_provider: string | null;
}

describe.skipIf(!hasIntegrationEnv() || !process.env.CREDENTIALS_ENCRYPTION_KEY)(
  "project model selection + auto-fill (integration, real Supabase)",
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

    const model = (modelId: string) => findCatalogModel(catalog, modelId);

    async function ownerWithKeys(label: string, providers: AIProviderCredentialType[]): Promise<string> {
      const user = await createTestUser(supabase, label);
      createdUsers.push(user.id);
      for (const provider of providers) {
        await saveAIProviderCredential(supabase, user.id, provider, `fake-${provider}-key-${user.id}`);
      }
      return user.id;
    }

    async function columns(projectId: string): Promise<ProjectModelColumns> {
      const { data, error } = await supabase
        .from("projects")
        .select("chat_model_id, embedding_model_id, active_ai_provider, embedding_provider")
        .eq("id", projectId)
        .single<ProjectModelColumns>();
      if (error) throw new Error(error.message);
      return data;
    }

    async function addDocument(projectId: string): Promise<void> {
      const { error } = await supabase.from("documents").insert({ project_id: projectId, title: "doc", source_type: "manual_upload" });
      if (error) throw new Error(error.message);
    }

    describe("selection", () => {
      it("a new project starts with no models and unlocked", async () => {
        const owner = await ownerWithKeys("selection-fresh", []);
        const project = await createTestProject(supabase, owner);

        expect(await getProjectModelState(supabase, project.id)).toEqual({
          chatModelId: null,
          embeddingModelId: null,
          embeddingLocked: false,
        });
      });

      it("stores the catalog id and mirrors the provider column", async () => {
        const owner = await ownerWithKeys("selection-chat", ["anthropic"]);
        const project = await createTestProject(supabase, owner);
        const sonnet = model("claude-sonnet-5");

        await setProjectChatModel(supabase, project.id, owner, sonnet.id);

        expect(await columns(project.id)).toMatchObject({ chat_model_id: sonnet.id, active_ai_provider: "anthropic" });
      });

      it("refuses a model whose provider key is missing, writing nothing", async () => {
        const owner = await ownerWithKeys("selection-no-key", ["openai"]);
        const project = await createTestProject(supabase, owner);

        await expect(setProjectChatModel(supabase, project.id, owner, model("gemini-3.8-flash").id)).rejects.toBeInstanceOf(
          MissingProviderCredentialsError
        );
        expect((await columns(project.id)).chat_model_id).toBeNull();
      });

      it("refuses a wrong-kind model and an id that isn't in the catalog", async () => {
        const owner = await ownerWithKeys("selection-invalid", ["openai"]);
        const project = await createTestProject(supabase, owner);

        const wrongKind = await setProjectChatModel(supabase, project.id, owner, model("text-embedding-3-small").id).catch(
          (e: unknown) => e
        );
        expect((wrongKind as InvalidModelSelectionError).reason).toBe("wrong_kind");

        const unknown = await setProjectEmbeddingModel(
          supabase,
          project.id,
          owner,
          "99999999-9999-4999-8999-999999999999"
        ).catch((e: unknown) => e);
        expect((unknown as InvalidModelSelectionError).reason).toBe("not_found");
      });

      it("embedding: free while empty, first choice allowed with documents, then locked", async () => {
        const owner = await ownerWithKeys("selection-lock", ["openai", "gemini"]);
        const project = await createTestProject(supabase, owner);
        await addDocument(project.id);

        await setProjectEmbeddingModel(supabase, project.id, owner, model("gemini-embedding-001").id);
        expect(await columns(project.id)).toMatchObject({
          embedding_model_id: model("gemini-embedding-001").id,
          embedding_provider: "gemini",
        });
        expect((await getProjectModelState(supabase, project.id)).embeddingLocked).toBe(true);

        await expect(
          setProjectEmbeddingModel(supabase, project.id, owner, model("text-embedding-3-large").id)
        ).rejects.toBeInstanceOf(EmbeddingModelLockedError);
        await expect(
          setProjectEmbeddingModel(supabase, project.id, owner, model("gemini-embedding-001").id)
        ).resolves.toMatchObject({ modelId: "gemini-embedding-001" });
        expect((await columns(project.id)).embedding_model_id).toBe(model("gemini-embedding-001").id);
      });

      it("rejects a project owned by a different user", async () => {
        const owner = await ownerWithKeys("selection-owner", []);
        const impostor = await ownerWithKeys("selection-impostor", ["openai"]);
        const project = await createTestProject(supabase, owner);

        await expect(setProjectChatModel(supabase, project.id, impostor, model("gpt-5.6-luna").id)).rejects.toThrow(
          /belongs to user/
        );
        expect((await columns(project.id)).chat_model_id).toBeNull();
      });
    });

    describe("auto-fill", () => {
      it("only an OpenAI key: fills both slots of every project with OpenAI's recommended models", async () => {
        const owner = await ownerWithKeys("autofill-openai", ["openai"]);
        const first = await createTestProject(supabase, owner, "first");
        const second = await createTestProject(supabase, owner, "second");

        await autoFillProjectModels(supabase, owner);

        for (const project of [first, second]) {
          expect(await columns(project.id)).toEqual({
            chat_model_id: model("gpt-5.6-luna").id,
            active_ai_provider: "openai",
            embedding_model_id: model("text-embedding-3-small").id,
            embedding_provider: "openai",
          });
        }
      });

      it("never overwrites a chosen model", async () => {
        const owner = await ownerWithKeys("autofill-keep", ["openai"]);
        const project = await createTestProject(supabase, owner);
        await setProjectChatModel(supabase, project.id, owner, model("gpt-4.1-mini").id);

        await autoFillProjectModels(supabase, owner);

        expect(await columns(project.id)).toMatchObject({
          chat_model_id: model("gpt-4.1-mini").id,
          embedding_model_id: model("text-embedding-3-small").id,
        });
      });

      it("OpenAI + Anthropic: chat stays empty (ambiguous), embeddings go to OpenAI", async () => {
        const owner = await ownerWithKeys("autofill-ambiguous", ["openai", "anthropic"]);
        const project = await createTestProject(supabase, owner);

        await autoFillProjectModels(supabase, owner);

        expect(await columns(project.id)).toMatchObject({
          chat_model_id: null,
          embedding_model_id: model("text-embedding-3-small").id,
        });
      });

      it("Anthropic + Voyage: Claude for chat, Voyage for embeddings", async () => {
        const owner = await ownerWithKeys("autofill-claude", ["anthropic", "voyage"]);
        const project = await createTestProject(supabase, owner);

        await autoFillProjectModels(supabase, owner);

        expect(await columns(project.id)).toEqual({
          chat_model_id: model("claude-opus-5").id,
          active_ai_provider: "anthropic",
          embedding_model_id: model("voyage-4-large").id,
          embedding_provider: "voyage",
        });
      });

      it("with projectId, touches only that project", async () => {
        const owner = await ownerWithKeys("autofill-scoped", ["gemini"]);
        const target = await createTestProject(supabase, owner, "target");
        const other = await createTestProject(supabase, owner, "other");

        await autoFillProjectModels(supabase, owner, { projectId: target.id });

        expect((await columns(target.id)).chat_model_id).toBe(model("gemini-3.8-flash").id);
        expect((await columns(other.id)).chat_model_id).toBeNull();
      });
    });
  }
);
