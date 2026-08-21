// lib/retrieval/__tests__/search.integration.test.ts
//
// Runs against a REAL local Supabase (see README "Running the integration
// tests" / `npm run test:integration`). Verifies the one thing that cannot
// be faked in a unit test: that match_document_chunks (db-architect's RPC)
// actually enforces per-PROJECT isolation and ordering when called the way
// lib/retrieval/search.ts calls it -- with fabricated, deterministic
// vectors (see lib/testing/integration-helpers.ts) instead of real
// embeddings, since no AI provider keys are available yet (see task
// context / README "What hasn't been tested live").
//
// PROJECTS PIVOT: match_document_chunks scopes by p_project_id now (not
// p_user_id) -- this file creates two separate PROJECTS (not just two
// users) to prove isolation holds at the level runRetrieval() actually
// calls the RPC at. The two projects are owned by two different users here
// only incidentally (simplest way to get two independent projects); the
// isolation guarantee being tested is project-level, and a same-user,
// two-project cross-leak would be exactly as bad -- see the "same owner,
// two projects" case below, which is the case that would NOT have been
// caught by only testing two different owners.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runRetrieval } from "../search";
import type { EmbeddingsProvider } from "../../ai/types";
import {
  createTestProject,
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
  let projectA: string;
  let projectB: string;
  let projectA2: string; // a SECOND project owned by the SAME user as projectA
  let docA: string;
  let docB: string;

  beforeAll(async () => {
    supabase = makeIntegrationSupabaseClient();
    userA = await createTestUser(supabase, "retrieval-a");
    userB = await createTestUser(supabase, "retrieval-b");

    projectA = (await createTestProject(supabase, userA.id, "Project A")).id;
    projectB = (await createTestProject(supabase, userB.id, "Project B")).id;
    projectA2 = (await createTestProject(supabase, userA.id, "Project A2")).id;

    const { data: docARow, error: docAErr } = await supabase
      .from("documents")
      .insert({ project_id: projectA, title: "Project A doc", source_type: "manual_upload" })
      .select("id")
      .single();
    if (docAErr) throw new Error(docAErr.message);
    docA = docARow.id as string;

    const { data: docBRow, error: docBErr } = await supabase
      .from("documents")
      .insert({ project_id: projectB, title: "Project B doc", source_type: "manual_upload" })
      .select("id")
      .single();
    if (docBErr) throw new Error(docBErr.message);
    docB = docBRow.id as string;

    const { error: chunksErr } = await supabase.from("document_chunks").insert([
      // Project A: an exact match and a less-similar match, to test ordering.
      {
        document_id: docA,
        chunk_index: 0,
        content: "Project A exact match chunk",
        embedding: deterministicVector(QUERY_AXIS),
        embedding_provider: "integration-fake",
        embedding_model: "integration-fake-model",
      },
      {
        document_id: docA,
        chunk_index: 1,
        content: "Project A less-similar chunk",
        embedding: blend(QUERY_AXIS, OTHER_AXIS, 0.8), // same primary axis, heavily blended -> lower cosine similarity
        embedding_provider: "integration-fake",
        embedding_model: "integration-fake-model",
      },
      // A chunk with no embedding yet -- must never be returned.
      {
        document_id: docA,
        chunk_index: 2,
        content: "Project A chunk with no embedding",
        embedding: null,
        embedding_provider: null,
        embedding_model: null,
      },
      // Project B: also an exact match to the same query vector -- this is
      // the critical cross-tenant isolation case. If match_document_chunks
      // (or runRetrieval's call to it) ever stopped scoping by
      // p_project_id, this row leaking into Project A's results is exactly
      // what would happen, silently.
      {
        document_id: docB,
        chunk_index: 0,
        content: "Project B exact match chunk (must never appear for Project A)",
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

  it("never returns another project's chunks, even a perfect vector match", async () => {
    const result = await runRetrieval(
      "irrelevant question text",
      projectA,
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
      projectA,
      { supabase, embeddingsProvider: embeddingsProviderReturning(deterministicVector(QUERY_AXIS)) },
      { matchCount: 10 }
    );

    const contents = result.sources.map((s) => s.chunkId);
    expect(contents).toHaveLength(2); // the null-embedding chunk must be excluded
    expect(result.sources[0].similarity).toBeGreaterThan(result.sources[1].similarity);
    expect(result.contextText).toContain("Project A exact match chunk");
    expect(result.contextText).not.toContain("no embedding");
  });

  it("passes the given projectId straight through as p_project_id (no cross-project leak, other direction)", async () => {
    // Calling with projectB's id must only ever surface projectB's own
    // chunk, never projectA's -- same guarantee, other direction.
    const result = await runRetrieval(
      "irrelevant question text",
      projectB,
      { supabase, embeddingsProvider: embeddingsProviderReturning(deterministicVector(QUERY_AXIS)) },
      { matchCount: 10 }
    );
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].documentId).toBe(docB);
  });

  it("a second project owned by the SAME user as project A sees no results -- isolation is per-project, not per-owner", async () => {
    const result = await runRetrieval(
      "irrelevant question text",
      projectA2,
      { supabase, embeddingsProvider: embeddingsProviderReturning(deterministicVector(QUERY_AXIS)) },
      { matchCount: 10 }
    );
    expect(result.sources).toEqual([]);
  });
});
