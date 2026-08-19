// lib/retrieval/__tests__/search.integration.test.ts
//
// Runs against a REAL local Supabase (see README "Running the integration
// tests" / `npm run test:integration`). Verifies the one thing that cannot
// be faked in a unit test: that match_document_chunks (db-architect's RPC)
// actually enforces per-user isolation and ordering when called the way
// lib/retrieval/search.ts calls it -- with fabricated, deterministic
// vectors (see lib/testing/integration-helpers.ts) instead of real
// embeddings, since no AI provider keys are available yet (see task
// context / README "What hasn't been tested live").

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runRetrieval } from "../search";
import type { EmbeddingsProvider } from "../../ai/types";
import {
  createTestUser,
  deleteTestUser,
  deterministicVector,
  hasIntegrationEnv,
  makeIntegrationSupabaseClient,
} from "../../testing/integration-helpers";

const QUERY_AXIS = 0;
const OTHER_AXIS = 1;

function blend(mainAxis: number, otherAxis: number, otherWeight: number): number[] {
  const v = deterministicVector(mainAxis);
  v[otherAxis] = otherWeight;
  return v;
}

function embeddingsProviderReturning(vector: number[]): EmbeddingsProvider {
  return {
    providerName: "integration-fake",
    modelName: "integration-fake-model",
    dimensions: vector.length,
    embed: async () => [vector],
  };
}

describe.skipIf(!hasIntegrationEnv())("runRetrieval (integration, real Supabase)", () => {
  let supabase: SupabaseClient;
  let userA: { id: string };
  let userB: { id: string };
  let docA: string;
  let docB: string;

  beforeAll(async () => {
    supabase = makeIntegrationSupabaseClient();
    userA = await createTestUser(supabase, "retrieval-a");
    userB = await createTestUser(supabase, "retrieval-b");

    const { data: docARow, error: docAErr } = await supabase
      .from("documents")
      .insert({ user_id: userA.id, title: "User A doc", source_type: "manual_upload" })
      .select("id")
      .single();
    if (docAErr) throw new Error(docAErr.message);
    docA = docARow.id as string;

    const { data: docBRow, error: docBErr } = await supabase
      .from("documents")
      .insert({ user_id: userB.id, title: "User B doc", source_type: "manual_upload" })
      .select("id")
      .single();
    if (docBErr) throw new Error(docBErr.message);
    docB = docBRow.id as string;

    const { error: chunksErr } = await supabase.from("document_chunks").insert([
      // User A: an exact match and a less-similar match, to test ordering.
      {
        document_id: docA,
        chunk_index: 0,
        content: "User A exact match chunk",
        embedding: deterministicVector(QUERY_AXIS),
        embedding_provider: "integration-fake",
        embedding_model: "integration-fake-model",
      },
      {
        document_id: docA,
        chunk_index: 1,
        content: "User A less-similar chunk",
        embedding: blend(QUERY_AXIS, OTHER_AXIS, 0.8), // same primary axis, heavily blended -> lower cosine similarity
        embedding_provider: "integration-fake",
        embedding_model: "integration-fake-model",
      },
      // A chunk with no embedding yet -- must never be returned.
      {
        document_id: docA,
        chunk_index: 2,
        content: "User A chunk with no embedding",
        embedding: null,
        embedding_provider: null,
        embedding_model: null,
      },
      // User B: also an exact match to the same query vector -- this is
      // the critical cross-tenant isolation case. If match_document_chunks
      // (or runRetrieval's call to it) ever stopped scoping by
      // p_user_id, this row leaking into User A's results is exactly what
      // would happen, silently.
      {
        document_id: docB,
        chunk_index: 0,
        content: "User B exact match chunk (must never appear for User A)",
        embedding: deterministicVector(QUERY_AXIS),
        embedding_provider: "integration-fake",
        embedding_model: "integration-fake-model",
      },
    ]);
    if (chunksErr) throw new Error(chunksErr.message);
  });

  afterAll(async () => {
    if (userA) await deleteTestUser(supabase, userA.id);
    if (userB) await deleteTestUser(supabase, userB.id);
  });

  it("never returns another user's chunks, even a perfect vector match", async () => {
    const result = await runRetrieval(
      "irrelevant question text",
      userA.id,
      { supabase, embeddingsProvider: embeddingsProviderReturning(deterministicVector(QUERY_AXIS)) },
      { matchCount: 10 }
    );

    expect(result.sources.length).toBeGreaterThan(0);
    for (const source of result.sources) {
      expect(source.documentId).not.toBe(docB);
    }
  });

  it("ranks the exact match above the less-similar chunk, and excludes chunks with no embedding", async () => {
    const result = await runRetrieval(
      "irrelevant question text",
      userA.id,
      { supabase, embeddingsProvider: embeddingsProviderReturning(deterministicVector(QUERY_AXIS)) },
      { matchCount: 10 }
    );

    const contents = result.sources.map((s) => s.chunkId);
    expect(contents).toHaveLength(2); // the null-embedding chunk must be excluded
    expect(result.sources[0].similarity).toBeGreaterThan(result.sources[1].similarity);
    expect(result.contextText).toContain("User A exact match chunk");
    expect(result.contextText).not.toContain("no embedding");
  });

  it("passes the server-validated userId straight through as p_user_id (no client override possible)", async () => {
    // Calling with userB's id must only ever surface userB's own chunk,
    // never userA's -- same guarantee, other direction.
    const result = await runRetrieval(
      "irrelevant question text",
      userB.id,
      { supabase, embeddingsProvider: embeddingsProviderReturning(deterministicVector(QUERY_AXIS)) },
      { matchCount: 10 }
    );
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].documentId).toBe(docB);
  });
});
