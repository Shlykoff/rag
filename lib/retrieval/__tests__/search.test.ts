import { describe, expect, it, vi } from "vitest";
import { runRetrieval, type MatchedChunk } from "../search";
import type { EmbeddingsProvider } from "../../ai/types";
import type { SupabaseClient } from "@supabase/supabase-js";

function fakeEmbeddings(vector: number[]): EmbeddingsProvider {
  return {
    providerName: "fake",
    modelName: "fake-model",
    dimensions: vector.length,
    embed: vi.fn().mockResolvedValue([vector]),
  };
}

function fakeSupabase(rpcResult: { data: MatchedChunk[] | null; error: { message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue(rpcResult);
  return { supabase: { rpc } as unknown as SupabaseClient, rpc };
}

function matchedChunk(overrides: Partial<MatchedChunk> = {}): MatchedChunk {
  return {
    chunk_id: "chunk-1",
    document_id: "doc-1",
    content: "Retrieved content.",
    chunk_index: 0,
    page_number: null,
    chunk_position: 0,
    similarity: 0.9,
    document_title: "Doc",
    document_source_type: "manual_upload",
    document_source_ref: null,
    ...overrides,
  };
}

describe("runRetrieval", () => {
  it("embeds the question and calls match_document_chunks with the given project id", async () => {
    const embeddingsProvider = fakeEmbeddings([0.1, 0.2, 0.3]);
    const { supabase, rpc } = fakeSupabase({ data: [matchedChunk()], error: null });

    const result = await runRetrieval("What is X?", "project-123", { supabase, embeddingsProvider });

    expect(embeddingsProvider.embed).toHaveBeenCalledWith(["What is X?"]);
    expect(rpc).toHaveBeenCalledWith("match_document_chunks", {
      query_embedding: [0.1, 0.2, 0.3],
      match_count: 6, // default
      p_project_id: "project-123", // MUST be exactly the projectId this function received, never client-supplied
    });
    expect(result.sources).toHaveLength(1);
    expect(result.candidateCount).toBe(1);
  });

  it("passes a custom matchCount through to the RPC", async () => {
    const embeddingsProvider = fakeEmbeddings([1, 2, 3]);
    const { supabase, rpc } = fakeSupabase({ data: [], error: null });
    await runRetrieval("q", "project-1", { supabase, embeddingsProvider }, { matchCount: 3 });
    expect(rpc).toHaveBeenCalledWith(
      "match_document_chunks",
      expect.objectContaining({ match_count: 3 })
    );
  });

  it("returns an empty context (not an error) when there are no matches", async () => {
    const embeddingsProvider = fakeEmbeddings([1, 2, 3]);
    const { supabase } = fakeSupabase({ data: [], error: null });
    const result = await runRetrieval("q", "project-1", { supabase, embeddingsProvider });
    expect(result.contextText).toBe("");
    expect(result.sources).toEqual([]);
    expect(result.candidateCount).toBe(0);
  });

  it("treats a null `data` from the RPC the same as an empty result set", async () => {
    const embeddingsProvider = fakeEmbeddings([1, 2, 3]);
    const { supabase } = fakeSupabase({ data: null, error: null });
    const result = await runRetrieval("q", "project-1", { supabase, embeddingsProvider });
    expect(result.candidateCount).toBe(0);
  });

  it("throws if the RPC returns an error", async () => {
    const embeddingsProvider = fakeEmbeddings([1, 2, 3]);
    const { supabase } = fakeSupabase({ data: null, error: { message: "permission denied" } });
    await expect(runRetrieval("q", "project-1", { supabase, embeddingsProvider })).rejects.toThrow(
      /permission denied/
    );
  });

  it("respects a custom maxContextTokens budget end-to-end", async () => {
    const embeddingsProvider = fakeEmbeddings([1, 2, 3]);
    const bigContent = "word ".repeat(80);
    const { supabase } = fakeSupabase({
      data: [
        matchedChunk({ chunk_id: "a", content: bigContent }),
        matchedChunk({ chunk_id: "b", content: bigContent }),
      ],
      error: null,
    });
    const result = await runRetrieval(
      "q",
      "project-1",
      { supabase, embeddingsProvider },
      { maxContextTokens: 150 }
    );
    expect(result.sources).toHaveLength(1);
    expect(result.candidateCount).toBe(2); // both were candidates, only 1 fit the budget
  });
});
