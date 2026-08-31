import { describe, expect, it, vi } from "vitest";
import { ingestDocument, type NormalizedDocument } from "../ingest";
import type { EmbeddingsProvider } from "../../ai/types";
import type { SupabaseClient } from "@supabase/supabase-js";

interface DocumentRow {
  id: string;
  project_id: string;
  source_type: "manual_upload" | "notion" | "url" | "google_drive";
}

interface FakeHandlers {
  fetchResult: { data: DocumentRow | null; error: { message: string } | null };
  updateResult?: { error: { message: string } | null };
  deleteResult?: { error: { message: string } | null };
  insertResult?: { error: { message: string } | null };
}

/** Minimal fake of the chained Postgrest builder for the exact calls ingestDocument makes -- see the comment above each branch below for which real call it stands in for. */
function makeFakeSupabase(handlers: FakeHandlers) {
  const documentUpdates: { id: string; payload: Record<string, unknown> }[] = [];
  const deletedDocumentIds: string[] = [];
  const insertedRows: Record<string, unknown>[][] = [];

  function from(table: string) {
    if (table === "documents") {
      return {
        // .select(...).eq("id", id).maybeSingle()
        select() {
          return this;
        },
        eq(_col: string, id: string) {
          (this as { _id?: string })._id = id;
          return this;
        },
        maybeSingle() {
          return Promise.resolve(handlers.fetchResult);
        },
        // .update(payload).eq("id", id)
        update(payload: Record<string, unknown>) {
          return {
            eq: async (_col: string, id: string) => {
              documentUpdates.push({ id, payload });
              return handlers.updateResult ?? { error: null };
            },
          };
        },
      };
    }
    if (table === "document_chunks") {
      return {
        // .delete().eq("document_id", id)
        delete() {
          return {
            eq: async (_col: string, documentId: string) => {
              deletedDocumentIds.push(documentId);
              return handlers.deleteResult ?? { error: null };
            },
          };
        },
        // .insert(rows)
        insert: async (rows: Record<string, unknown>[]) => {
          insertedRows.push(rows);
          return handlers.insertResult ?? { error: null };
        },
      };
    }
    throw new Error(`makeFakeSupabase: unexpected table ${table}`);
  }

  const supabase = { from } as unknown as SupabaseClient;
  return { supabase, documentUpdates, deletedDocumentIds, insertedRows };
}

function fakeEmbeddings(dimensions = 3): EmbeddingsProvider {
  return {
    providerName: "fake-provider",
    modelName: "fake-model",
    dimensions,
    embed: vi.fn().mockImplementation(async (texts: string[]) =>
      texts.map((_, i) => Array.from({ length: dimensions }, (_, d) => i + d))
    ),
  };
}

const baseDoc: NormalizedDocument = {
  documentId: "doc-1",
  projectId: "project-1",
  ownerUserId: "owner-1",
  title: "My Document",
  text: "First sentence here. Second sentence follows. Third one too.",
};

describe("ingestDocument", () => {
  it("chunks, embeds, delete-before-inserts, and marks the document ready", async () => {
    const { supabase, documentUpdates, deletedDocumentIds, insertedRows } = makeFakeSupabase({
      fetchResult: { data: { id: "doc-1", project_id: "project-1", source_type: "notion" }, error: null },
    });
    const embeddingsProvider = fakeEmbeddings();

    const result = await ingestDocument(baseDoc, { supabase, embeddingsProvider });

    expect(result.chunkCount).toBeGreaterThan(0);
    expect(result.embeddingProvider).toBe("fake-provider");
    expect(result.embeddingModel).toBe("fake-model");

    // Delete happens before insert (idempotent re-sync contract).
    expect(deletedDocumentIds).toEqual(["doc-1"]);
    expect(insertedRows).toHaveLength(1);
    const rows = insertedRows[0];
    expect(rows).toHaveLength(result.chunkCount);
    rows.forEach((row, i) => {
      expect(row.document_id).toBe("doc-1");
      expect(row.chunk_index).toBe(i);
      expect(row.chunk_position).toBe(i);
      expect(row.page_number).toBeNull();
      expect(row.embedding_provider).toBe("fake-provider");
      expect(row.embedding_model).toBe("fake-model");
      expect(Array.isArray(row.embedding)).toBe(true);
    });

    // First update flips to 'processing', second (final) flips to 'ready'
    // with last_synced_at stamped (source_type is 'notion', not manual_upload).
    expect(documentUpdates[0].payload).toMatchObject({ processing_status: "processing" });
    const finalUpdate = documentUpdates[documentUpdates.length - 1].payload;
    expect(finalUpdate).toMatchObject({ processing_status: "ready", processing_error: null });
    expect(finalUpdate.last_synced_at).toBeTypeOf("string");
  });

  it("does NOT stamp last_synced_at for manual_upload documents", async () => {
    const { supabase, documentUpdates } = makeFakeSupabase({
      fetchResult: { data: { id: "doc-1", project_id: "project-1", source_type: "manual_upload" }, error: null },
    });
    await ingestDocument(baseDoc, { supabase, embeddingsProvider: fakeEmbeddings() });
    const finalUpdate = documentUpdates[documentUpdates.length - 1].payload;
    expect(finalUpdate.processing_status).toBe("ready");
    expect(finalUpdate.last_synced_at).toBeUndefined();
  });

  it("throws and makes no writes when the document does not belong to the given projectId", async () => {
    const { supabase, documentUpdates, deletedDocumentIds } = makeFakeSupabase({
      fetchResult: { data: { id: "doc-1", project_id: "someone-elses-project", source_type: "manual_upload" }, error: null },
    });
    await expect(
      ingestDocument(baseDoc, { supabase, embeddingsProvider: fakeEmbeddings() })
    ).rejects.toThrow(/belongs to project someone-elses-project/);
    expect(documentUpdates).toHaveLength(0);
    expect(deletedDocumentIds).toHaveLength(0);
  });

  it("throws when the document row does not exist", async () => {
    const { supabase } = makeFakeSupabase({ fetchResult: { data: null, error: null } });
    await expect(
      ingestDocument(baseDoc, { supabase, embeddingsProvider: fakeEmbeddings() })
    ).rejects.toThrow(/does not exist/);
  });

  it("marks the document 'error' (not 'ready') when the text has no extractable content", async () => {
    const { supabase, documentUpdates } = makeFakeSupabase({
      fetchResult: { data: { id: "doc-1", project_id: "project-1", source_type: "manual_upload" }, error: null },
    });
    await expect(
      ingestDocument({ ...baseDoc, text: "   " }, { supabase, embeddingsProvider: fakeEmbeddings() })
    ).rejects.toThrow();
    const finalUpdate = documentUpdates[documentUpdates.length - 1].payload;
    expect(finalUpdate.processing_status).toBe("error");
    expect(finalUpdate.processing_error).toMatch(/не содержит текста/);
  });

  // Regression test: the chunk-delete must run AFTER a successful embed,
  // never concurrently with (or before) the embed attempt -- a Promise.all
  // version of this pipeline was tried and reverted specifically because it
  // meant ANY embed failure (expired key, transient network blip, provider
  // rate limit -- all realistic right at the moment of a manual "Refresh")
  // would unconditionally wipe the existing, still-servable chunk set,
  // making a previously-working document instantly unsearchable instead of
  // leaving it stale-but-searchable until the next successful sync. This
  // asserts the old chunks are never even touched when embedding fails.
  it("marks the document 'error' and rethrows when the embeddings provider fails, WITHOUT deleting the existing chunks", async () => {
    const { supabase, documentUpdates, deletedDocumentIds } = makeFakeSupabase({
      fetchResult: { data: { id: "doc-1", project_id: "project-1", source_type: "manual_upload" }, error: null },
    });
    const failingEmbeddings: EmbeddingsProvider = {
      providerName: "fake",
      modelName: "fake-model",
      dimensions: 3,
      embed: vi.fn().mockRejectedValue(new Error("provider down")),
    };
    await expect(
      ingestDocument(baseDoc, { supabase, embeddingsProvider: failingEmbeddings })
    ).rejects.toThrow(/provider down/);
    const finalUpdate = documentUpdates[documentUpdates.length - 1].payload;
    expect(finalUpdate.processing_status).toBe("error");
    expect(finalUpdate.processing_error).toMatch(/provider down/);
    // The old (still-servable) chunk set must be left completely alone on
    // an embed failure -- the delete call must never even happen.
    expect(deletedDocumentIds).toHaveLength(0);
  });

  it("marks the document 'error' and rethrows when the chunk delete fails", async () => {
    const { supabase, documentUpdates } = makeFakeSupabase({
      fetchResult: { data: { id: "doc-1", project_id: "project-1", source_type: "manual_upload" }, error: null },
      deleteResult: { error: { message: "delete failed" } },
    });
    await expect(
      ingestDocument(baseDoc, { supabase, embeddingsProvider: fakeEmbeddings() })
    ).rejects.toThrow(/delete failed/);
    const finalUpdate = documentUpdates[documentUpdates.length - 1].payload;
    expect(finalUpdate.processing_status).toBe("error");
  });

  it("marks the document 'error' and rethrows when the chunk insert fails", async () => {
    const { supabase, documentUpdates } = makeFakeSupabase({
      fetchResult: { data: { id: "doc-1", project_id: "project-1", source_type: "manual_upload" }, error: null },
      insertResult: { error: { message: "insert failed" } },
    });
    await expect(
      ingestDocument(baseDoc, { supabase, embeddingsProvider: fakeEmbeddings() })
    ).rejects.toThrow(/insert failed/);
    const finalUpdate = documentUpdates[documentUpdates.length - 1].payload;
    expect(finalUpdate.processing_status).toBe("error");
  });

  it("re-running ingestDocument (simulating a manual Refresh) deletes existing chunks again before inserting the new set", async () => {
    const { supabase, deletedDocumentIds, insertedRows } = makeFakeSupabase({
      fetchResult: { data: { id: "doc-1", project_id: "project-1", source_type: "url" }, error: null },
    });
    const embeddingsProvider = fakeEmbeddings();

    await ingestDocument(baseDoc, { supabase, embeddingsProvider });
    await ingestDocument({ ...baseDoc, text: "A shorter refreshed document. Just this." }, { supabase, embeddingsProvider });

    expect(deletedDocumentIds).toEqual(["doc-1", "doc-1"]);
    expect(insertedRows).toHaveLength(2);
    // The second ingest's chunk set (for the shorter refreshed text) is its
    // own independent set of rows, all still indexed from 0 -- nothing
    // here depends on or extends the first ingest's chunk_index range,
    // which is exactly what avoids leaving orphaned high-index chunks
    // behind when a document shrinks (see the migration's table comment).
    expect(insertedRows[1][0].chunk_index).toBe(0);
  });
});
