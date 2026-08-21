// lib/ingestion/__tests__/ingest.integration.test.ts
//
// Runs against a REAL local Supabase (see README "Running the integration
// tests" / `npm run test:integration`). The unit test (ingest.test.ts)
// fakes the Supabase client entirely; this verifies the pipeline against
// the real `documents`/`document_chunks` tables, including the
// document_chunks_document_chunk_index_unique constraint and the
// delete-before-insert re-sync contract actually holding up against
// Postgres, not just against a mock that trusts whatever ingest.ts does.
//
// Uses a deterministic fake EmbeddingsProvider (no AI provider keys are
// available yet -- see README "What hasn't been tested live").

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ingestDocument } from "../ingest";
import type { EmbeddingsProvider } from "../../ai/types";
import {
  createTestProject,
  createTestUser,
  deleteTestUser,
  hasIntegrationEnv,
  makeIntegrationSupabaseClient,
} from "../../testing/integration-helpers";

function deterministicEmbeddings(): EmbeddingsProvider {
  return {
    providerName: "integration-fake",
    modelName: "integration-fake-model",
    dimensions: 1024,
    embed: async (texts: string[]) =>
      texts.map((_, i) => {
        const v = new Array(1024).fill(0);
        v[i % 1024] = 1;
        return v;
      }),
  };
}

describe.skipIf(!hasIntegrationEnv())("ingestDocument (integration, real Supabase)", () => {
  let supabase: SupabaseClient;
  let userId: string;
  let projectId: string;
  let documentId: string;

  beforeAll(async () => {
    supabase = makeIntegrationSupabaseClient();
    const user = await createTestUser(supabase, "ingest");
    userId = user.id;
    projectId = (await createTestProject(supabase, userId)).id;

    const { data, error } = await supabase
      .from("documents")
      .insert({ project_id: projectId, title: "Integration test doc", source_type: "notion", source_ref: "notion://fake-page" })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    documentId = data.id as string;
  });

  afterAll(async () => {
    if (userId) await deleteTestUser(supabase, userId);
  });

  it("chunks, embeds, stores chunks, and flips processing_status to ready with last_synced_at set", async () => {
    const longText = Array.from(
      { length: 30 },
      (_, i) => `This is sentence number ${i} of the integration test document, with a bit more padding text to reach a reasonable chunk size.`
    ).join(" ");

    const result = await ingestDocument(
      { documentId, projectId, ownerUserId: userId, title: "Integration test doc", text: longText },
      { supabase, embeddingsProvider: deterministicEmbeddings() },
      { targetTokens: 100, overlapTokens: 15 }
    );

    expect(result.chunkCount).toBeGreaterThan(1);

    const { data: chunks, error: chunksErr } = await supabase
      .from("document_chunks")
      .select("chunk_index, embedding_provider, embedding_model")
      .eq("document_id", documentId)
      .order("chunk_index", { ascending: true });
    if (chunksErr) throw new Error(chunksErr.message);
    expect(chunks).toHaveLength(result.chunkCount);
    chunks!.forEach((row, i) => {
      expect(row.chunk_index).toBe(i);
      expect(row.embedding_provider).toBe("integration-fake");
    });

    const { data: doc, error: docErr } = await supabase
      .from("documents")
      .select("processing_status, processing_error, last_synced_at")
      .eq("id", documentId)
      .single();
    if (docErr) throw new Error(docErr.message);
    expect(doc.processing_status).toBe("ready");
    expect(doc.processing_error).toBeNull();
    expect(doc.last_synced_at).not.toBeNull(); // source_type 'notion' -- always stamped on success
  });

  it("re-ingesting (simulating Refresh) deletes the old chunk set before inserting the new one -- no orphaned trailing chunks", async () => {
    // Re-ingest with much shorter text than the first run -> fewer chunks.
    const shortText = "Just one short sentence for the refreshed version.";
    const result = await ingestDocument(
      { documentId, projectId, ownerUserId: userId, title: "Integration test doc", text: shortText },
      { supabase, embeddingsProvider: deterministicEmbeddings() }
    );

    const { data: chunks, error } = await supabase
      .from("document_chunks")
      .select("chunk_index")
      .eq("document_id", documentId)
      .order("chunk_index", { ascending: true });
    if (error) throw new Error(error.message);

    // Exactly the new chunk count remains -- if delete-before-insert were
    // broken, this would instead show the old (larger) chunk count, or a
    // mix of old high-index rows alongside the new ones.
    expect(chunks).toHaveLength(result.chunkCount);
    expect(chunks!.map((c) => c.chunk_index)).toEqual(
      Array.from({ length: result.chunkCount }, (_, i) => i)
    );
  });
});
