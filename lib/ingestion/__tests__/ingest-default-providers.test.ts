// lib/ingestion/__tests__/ingest-default-providers.test.ts
//
// Regression test for the bug qa-reviewer reproduced live: getEmbeddingsProvider()
// (via getAIProviders(), see lib/ai/index.ts) throws SYNCHRONOUSLY when
// AI_PROVIDER/its matching *_API_KEY env var is missing or invalid. Before
// the fix, ingestDocumentWithDefaultProviders() computed that call as an
// eagerly-evaluated argument to ingestDocument(...) -- so the throw
// happened BEFORE ingestDocument()'s own try/catch (which flips
// documents.processing_status to 'error') ever started running, leaving
// the document stuck in 'pending' forever with processing_error: null.
//
// This file exercises ingestDocumentWithDefaultProviders() itself (not
// ingestDocument(), which is already covered end-to-end by ingest.test.ts)
// by mocking its two module-level dependencies -- getServiceRoleClient()
// and getEmbeddingsProvider() -- exactly the two calls the bug report
// pointed at.

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const mockGetServiceRoleClient = vi.fn();
const mockGetEmbeddingsProvider = vi.fn();

// Paths are resolved relative to THIS file, but must point at the same
// modules ingest.ts itself imports ("../supabase/service-client" and
// "../ai" from lib/ingestion/ingest.ts) for vitest to intercept the calls
// ingest.ts actually makes.
vi.mock("../../supabase/service-client", () => ({
  getServiceRoleClient: () => mockGetServiceRoleClient(),
}));

vi.mock("../../ai", () => ({
  getEmbeddingsProvider: () => mockGetEmbeddingsProvider(),
}));

import { ingestDocumentWithDefaultProviders } from "../ingest";
import type { NormalizedDocument } from "../ingest";

interface DocumentRow {
  id: string;
  user_id: string;
  source_type: "manual_upload" | "notion" | "url" | "google_drive";
}

/** Same minimal fake shape as ingest.test.ts's makeFakeSupabase, trimmed to
 * only the "documents" table calls this code path can reach (the failure
 * happens before ingestDocument() ever touches document_chunks). */
function makeFakeSupabase(fetchResult: { data: DocumentRow | null; error: { message: string } | null }) {
  const documentUpdates: { id: string; payload: Record<string, unknown> }[] = [];

  function from(table: string) {
    if (table === "documents") {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        maybeSingle() {
          return Promise.resolve(fetchResult);
        },
        update(payload: Record<string, unknown>) {
          return {
            eq: async (_col: string, id: string) => {
              documentUpdates.push({ id, payload });
              return { error: null };
            },
          };
        },
      };
    }
    throw new Error(`makeFakeSupabase: unexpected table ${table}`);
  }

  const supabase = { from } as unknown as SupabaseClient;
  return { supabase, documentUpdates };
}

const baseDoc: NormalizedDocument = {
  documentId: "doc-1",
  userId: "user-1",
  title: "My Document",
  text: "First sentence here. Second sentence follows.",
};

describe("ingestDocumentWithDefaultProviders", () => {
  beforeEach(() => {
    mockGetServiceRoleClient.mockReset();
    mockGetEmbeddingsProvider.mockReset();
  });

  it("marks the document 'error' (not stuck in 'pending') when getEmbeddingsProvider() throws synchronously", async () => {
    const { supabase, documentUpdates } = makeFakeSupabase({
      data: { id: "doc-1", user_id: "user-1", source_type: "manual_upload" },
      error: null,
    });
    mockGetServiceRoleClient.mockReturnValue(supabase);
    mockGetEmbeddingsProvider.mockImplementation(() => {
      throw new Error(
        "Invalid or missing AI_PROVIDER env var (got: undefined). Expected one of: 'openai' | 'anthropic' | 'gemini'. See .env.example."
      );
    });

    await expect(ingestDocumentWithDefaultProviders(baseDoc)).rejects.toThrow(/AI_PROVIDER/);

    // The critical assertion: exactly one status write happened, and it
    // flips straight to 'error' with a non-empty processing_error -- NOT
    // left as 'pending' (the pre-fix bug) and NOT even reaching
    // 'processing' (ingestDocument()'s own first write), since the failure
    // happens before ingestDocument() is ever called.
    expect(documentUpdates).toHaveLength(1);
    expect(documentUpdates[0].id).toBe("doc-1");
    expect(documentUpdates[0].payload.processing_status).toBe("error");
    expect(documentUpdates[0].payload.processing_error).toBeTruthy();
    expect(documentUpdates[0].payload.processing_error).toMatch(/AI_PROVIDER/);
  });

  it("still throws (does not swallow the error) after recording processing_status: 'error'", async () => {
    const { supabase } = makeFakeSupabase({
      data: { id: "doc-1", user_id: "user-1", source_type: "manual_upload" },
      error: null,
    });
    mockGetServiceRoleClient.mockReturnValue(supabase);
    const originalError = new Error("Missing required env var OPENAI_API_KEY for the active AI_PROVIDER.");
    mockGetEmbeddingsProvider.mockImplementation(() => {
      throw originalError;
    });

    // The caller (document-sources-specialist's upload/refresh route
    // handlers) still needs to see this as a rejected promise -- silently
    // resolving would hide the failure from whatever kicked off ingestion,
    // even though the DB row is now correctly marked.
    await expect(ingestDocumentWithDefaultProviders(baseDoc)).rejects.toBe(originalError);
  });

  it("delegates to the real pipeline (no early error write) when getEmbeddingsProvider() succeeds", async () => {
    const { supabase, documentUpdates } = makeFakeSupabase({
      data: { id: "doc-1", user_id: "user-1", source_type: "manual_upload" },
      error: null,
    });
    mockGetServiceRoleClient.mockReturnValue(supabase);
    mockGetEmbeddingsProvider.mockReturnValue({
      providerName: "fake-provider",
      modelName: "fake-model",
      dimensions: 3,
      embed: vi.fn().mockImplementation(async (texts: string[]) =>
        texts.map((_, i) => [i, i + 1, i + 2])
      ),
    });

    // makeFakeSupabase above only stubs the "documents" table; document_chunks
    // is reached on the success path, so extend the fake here rather than
    // widen the shared helper (only this one test needs it).
    const documentChunkRows: Record<string, unknown>[] = [];
    const originalFrom = supabase.from.bind(supabase);
    (supabase as unknown as { from: (table: string) => unknown }).from = (table: string) => {
      if (table === "document_chunks") {
        return {
          delete: () => ({ eq: async () => ({ error: null }) }),
          insert: async (rows: Record<string, unknown>[]) => {
            documentChunkRows.push(...rows);
            return { error: null };
          },
        };
      }
      return originalFrom(table);
    };

    const result = await ingestDocumentWithDefaultProviders(baseDoc);

    expect(result.embeddingProvider).toBe("fake-provider");
    expect(documentChunkRows.length).toBeGreaterThan(0);
    const finalUpdate = documentUpdates[documentUpdates.length - 1].payload;
    expect(finalUpdate.processing_status).toBe("ready");
  });
});
