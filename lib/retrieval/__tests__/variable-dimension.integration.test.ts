// lib/retrieval/__tests__/variable-dimension.integration.test.ts
//
// Ingestion + retrieval end to end with a non-1024 catalog embedding model,
// against a REAL local Supabase: chunks are stored at the model's dimension
// under its model id, and a question embedded by that model finds them. A
// deterministic keyword embedder stands in for the real model (no API key).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ingestDocument } from "../../ingestion/ingest";
import { runRetrieval } from "../search";
import { listAIModels } from "../../ai/catalog";
import { createKeywordEmbeddingsProvider } from "../../testing/keyword-embeddings";
import { findCatalogModel } from "../../testing/ai-model-fixtures";
import {
  createTestProject,
  createTestUser,
  deleteTestUser,
  hasIntegrationEnv,
  makeIntegrationSupabaseClient,
} from "../../testing/integration-helpers";

const REFUNDS = `Refund policy. Customers can return any purchase within thirty days for a full refund.
Refunds are issued to the original payment method within five business days after the return is received.`;

const ONBOARDING = `Employee onboarding. New employees receive a laptop and badge on their first day.
The onboarding checklist covers payroll enrollment, security training and meeting the team.`;

describe.skipIf(!hasIntegrationEnv())("ingestion + retrieval with a 3072-dim catalog model (integration)", () => {
  let supabase: SupabaseClient;
  let userId: string;
  let projectId: string;
  let modelId: string;

  beforeAll(async () => {
    supabase = makeIntegrationSupabaseClient();
    userId = (await createTestUser(supabase, "variable-dimension")).id;
    projectId = (await createTestProject(supabase, userId)).id;

    const model = findCatalogModel(await listAIModels(supabase), "text-embedding-3-large");
    expect(model.dimensions).toBe(3072);
    modelId = model.modelId;
    const { error } = await supabase
      .from("projects")
      .update({ embedding_model_id: model.id, embedding_provider: model.provider })
      .eq("id", projectId);
    if (error) throw new Error(error.message);

    const embeddingsProvider = createKeywordEmbeddingsProvider({ dimensions: 3072, providerName: model.provider, modelName: model.modelId });
    for (const [title, text] of [
      ["Refund policy", REFUNDS],
      ["Onboarding guide", ONBOARDING],
    ]) {
      const { data, error: docError } = await supabase
        .from("documents")
        .insert({ project_id: projectId, title, source_type: "manual_upload" })
        .select("id")
        .single();
      if (docError) throw new Error(docError.message);
      await ingestDocument({ documentId: data.id as string, projectId, ownerUserId: userId, title, text }, { supabase, embeddingsProvider });
    }
  });

  afterAll(async () => {
    if (userId) await deleteTestUser(supabase, userId);
  });

  it("stores chunks at the model's dimension under its catalog model id", async () => {
    const { data, error } = await supabase
      .from("document_chunks")
      .select("embedding, embedding_provider, embedding_model, documents!inner(project_id)")
      .eq("documents.project_id", projectId);
    if (error) throw new Error(error.message);
    expect(data.length).toBeGreaterThan(0);
    for (const row of data as { embedding: string; embedding_provider: string; embedding_model: string }[]) {
      expect(row.embedding_provider).toBe("openai");
      expect(row.embedding_model).toBe(modelId);
      expect((JSON.parse(row.embedding) as number[]).length).toBe(3072);
    }
  });

  it("a question embedded by the same model retrieves the matching document first", async () => {
    const result = await runRetrieval("How many days do refunds take to reach the payment method?", projectId, {
      supabase,
      embeddingsProvider: createKeywordEmbeddingsProvider({ dimensions: 3072, providerName: "openai", modelName: modelId }),
    });

    expect(result.sources[0]?.documentTitle).toBe("Refund policy");
  });

  it("a query of another dimension under the same model name finds nothing, without an error", async () => {
    const result = await runRetrieval("refunds", projectId, {
      supabase,
      embeddingsProvider: createKeywordEmbeddingsProvider({ dimensions: 1024, providerName: "openai", modelName: modelId }),
    });

    expect(result.sources).toEqual([]);
  });
});
