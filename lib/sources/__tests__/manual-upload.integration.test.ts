// lib/sources/__tests__/manual-upload.integration.test.ts
//
// End-to-end manual-upload test against a REAL local Supabase (Storage +
// Postgres) -- the one source this project can exercise fully without any
// external API key (see the task context: "ручная загрузка файлов вообще
// не требует внешних ключей и должна быть протестирована полностью,
// включая реальную загрузку в локальный Storage"). Covers the exact path
// app/api/sources/upload/route.ts drives: extract text
// (lib/sources/manual-upload.ts) -> upload the original file to the real
// "documents" Storage bucket (same path convention as
// lib/sources/pipeline.ts) -> run the real chunk/embed/store pipeline
// (lib/ingestion/ingest.ts's `ingestDocument`, injected with a
// deterministic fake EmbeddingsProvider -- no AI_PROVIDER/API key needed,
// same DI pattern as lib/ingestion/__tests__/ingest.integration.test.ts).
//
// Deliberately calls the building blocks directly rather than going
// through the HTTP route: this project's existing integration tests talk
// to Supabase directly (no HTTP server harness), and
// createDocumentFromSource() (lib/sources/pipeline.ts) hardcodes the REAL
// AI-provider-backed ingest wrapper, which isn't callable without a real
// API key -- so this test reconstructs the same sequence
// (insert pending row -> upload -> set storage_path -> ingest) using the
// lower-level, dependency-injectable `ingestDocument`, keeping it exactly
// as faithful to the real code path while staying key-free.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ingestDocument } from "../../ingestion/ingest";
import type { EmbeddingsProvider } from "../../ai/types";
import { processManualUpload } from "../manual-upload";
import {
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

const SAMPLE_TEXT = Array.from(
  { length: 20 },
  (_, i) => `Paragraph ${i}: this is sample manual-upload content used to prove the end-to-end Storage + ingest path works.`
).join("\n\n");

describe.skipIf(!hasIntegrationEnv())("manual upload (integration, real Supabase Storage + Postgres)", () => {
  let supabase: SupabaseClient;
  let userId: string;
  let documentId: string;
  const uploadedPaths: string[] = [];

  beforeAll(async () => {
    supabase = makeIntegrationSupabaseClient();
    const user = await createTestUser(supabase, "manual-upload");
    userId = user.id;
  });

  afterAll(async () => {
    if (uploadedPaths.length > 0) {
      await supabase.storage.from("documents").remove(uploadedPaths);
    }
    if (userId) await deleteTestUser(supabase, userId);
  });

  it("extracts text from a real .txt buffer, uploads the original to Storage, and ingests it into ready chunks", async () => {
    const buffer = Buffer.from(SAMPLE_TEXT, "utf-8");

    // 1. Real text extraction (no mocking -- lib/sources/text-extraction.ts's
    // "text" branch is just a UTF-8 decode, but this proves the whole
    // processManualUpload validation/extraction path, same as the route).
    const normalized = await processManualUpload({ filename: "notes.txt", mimeType: "text/plain", buffer });
    expect(normalized.text).toBe(SAMPLE_TEXT);
    expect(normalized.title).toBe("notes");

    // 2. Insert the `documents` row the way lib/sources/pipeline.ts's
    // createDocumentFromSource does (pending -> upload -> set storage_path).
    const { data: docRow, error: insertError } = await supabase
      .from("documents")
      .insert({ user_id: userId, title: normalized.title, source_type: "manual_upload", source_ref: null, processing_status: "pending" })
      .select("id")
      .single();
    if (insertError) throw new Error(insertError.message);
    documentId = docRow.id as string;

    // 3. Real upload to the real, private "documents" Storage bucket, at
    // the "<user_id>/<document_id>/original.<ext>" path the
    // documents_storage_path_prefixed_with_user_id DB constraint requires.
    const storagePath = `${userId}/${documentId}/original.${normalized.original.extension}`;
    uploadedPaths.push(storagePath);
    const { error: uploadError } = await supabase.storage
      .from("documents")
      .upload(storagePath, normalized.original.buffer, { contentType: normalized.original.contentType });
    if (uploadError) throw new Error(uploadError.message);

    const { error: pathUpdateError } = await supabase.from("documents").update({ storage_path: storagePath }).eq("id", documentId);
    if (pathUpdateError) throw new Error(pathUpdateError.message);

    // 4. Round-trip proof: download the object back and confirm it's byte-
    // identical to what was uploaded -- this is what makes chunks
    // reconstructible without re-uploading (see the documents migration's
    // storage_path comment / CLAUDE.md's "чанки можно пересобрать без
    // повторного похода к источнику").
    const { data: downloaded, error: downloadError } = await supabase.storage.from("documents").download(storagePath);
    if (downloadError) throw new Error(downloadError.message);
    const downloadedBuffer = Buffer.from(await downloaded.arrayBuffer());
    expect(downloadedBuffer.equals(normalized.original.buffer)).toBe(true);

    // 5. Real chunk/embed/store pipeline (lib/ingestion/ingest.ts), with a
    // fake EmbeddingsProvider standing in for a real AI provider -- see
    // module header for why this is injected here rather than going
    // through lib/sources/pipeline.ts's real-provider-hardcoded wrapper.
    const result = await ingestDocument(
      { documentId, userId, title: normalized.title, text: normalized.text },
      { supabase, embeddingsProvider: deterministicEmbeddings() },
      { targetTokens: 80, overlapTokens: 10 }
    );
    expect(result.chunkCount).toBeGreaterThan(1);

    const { data: chunks, error: chunksError } = await supabase
      .from("document_chunks")
      .select("chunk_index")
      .eq("document_id", documentId)
      .order("chunk_index", { ascending: true });
    if (chunksError) throw new Error(chunksError.message);
    expect(chunks).toHaveLength(result.chunkCount);

    const { data: finalDoc, error: finalDocError } = await supabase
      .from("documents")
      .select("processing_status, processing_error, storage_path, last_synced_at, source_type")
      .eq("id", documentId)
      .single();
    if (finalDocError) throw new Error(finalDocError.message);
    expect(finalDoc.processing_status).toBe("ready");
    expect(finalDoc.processing_error).toBeNull();
    expect(finalDoc.storage_path).toBe(storagePath);
    // manual_upload never gets last_synced_at stamped -- there's nothing
    // external to (re-)sync (see lib/ingestion/ingest.ts's comment on this).
    expect(finalDoc.last_synced_at).toBeNull();
  });
});
