// lib/ingestion/ingest.ts
//
// The ingestion pipeline: chunk -> embed -> delete-before-insert into
// document_chunks -> flip documents.processing_status. Takes an already-
// normalized document ({ documentId, userId, title, text }) -- this module
// never fetches from Notion/URL/Drive/disk itself, that's
// document-sources-specialist's job (see CLAUDE.md). Called once per
// initial ingest AND once per manual "Refresh" re-sync; both paths go
// through this exact same function, which is what makes re-sync
// idempotent (delete-before-insert, not insert-or-update) -- see the
// document_chunks migration's table comment for why that contract is
// load-bearing (a shrinking document must not leave orphaned trailing
// chunks behind).

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EmbeddingsProvider } from "../ai/types";
import { AIProviderError } from "../ai/errors";
import { chunkText, type ChunkOptions } from "./chunk";
import { getServiceRoleClient } from "../supabase/service-client";
import { getEmbeddingsProvider } from "../ai";

export interface NormalizedDocument {
  documentId: string;
  userId: string;
  title: string;
  text: string;
}

export interface IngestDeps {
  supabase: SupabaseClient;
  embeddingsProvider: EmbeddingsProvider;
}

export interface IngestResult {
  documentId: string;
  chunkCount: number;
  embeddingProvider: string;
  embeddingModel: string;
}

/** Row shape this module needs from `documents` -- just enough to verify ownership and decide whether to stamp last_synced_at (manual_upload never gets one; see the documents migration's column comment). */
interface DocumentRow {
  id: string;
  user_id: string;
  source_type: "manual_upload" | "notion" | "url" | "google_drive";
}

async function setProcessingStatus(
  supabase: SupabaseClient,
  documentId: string,
  update: {
    processing_status: "processing" | "ready" | "error";
    processing_error?: string | null;
    last_synced_at?: string;
  }
): Promise<void> {
  const { error } = await supabase.from("documents").update(update).eq("id", documentId);
  if (error) {
    // This is a best-effort status update on top of a pipeline that may
    // have already failed for its own reason -- log rather than throw, so
    // we don't mask the original error with a secondary DB-write failure.
    console.error(
      `ingestDocument: failed to update documents.processing_status for ${documentId}: ${error.message}`
    );
  }
}

/**
 * Runs the full chunk -> embed -> store pipeline for one already-normalized
 * document. Idempotent: safe to call again for the same documentId (e.g.
 * a user-triggered "Refresh") -- existing chunks are deleted before the
 * new set is inserted (see module comment).
 */
export async function ingestDocument(
  doc: NormalizedDocument,
  deps: IngestDeps,
  chunkOptions?: ChunkOptions
): Promise<IngestResult> {
  const { supabase, embeddingsProvider } = deps;

  const { data: documentRow, error: fetchError } = await supabase
    .from("documents")
    .select("id, user_id, source_type")
    .eq("id", doc.documentId)
    .maybeSingle<DocumentRow>();

  if (fetchError) {
    throw new Error(`ingestDocument: failed to load document ${doc.documentId}: ${fetchError.message}`);
  }
  if (!documentRow) {
    throw new Error(`ingestDocument: document ${doc.documentId} does not exist`);
  }
  // Defense in depth: even though this pipeline always runs server-side
  // with a service-role client (which bypasses RLS), never silently
  // process a document that doesn't actually belong to the caller-supplied
  // userId -- a mismatch here means the caller (document-sources-
  // specialist / an API route) has a bug, and we'd rather fail loudly than
  // embed one user's content under another user's document row.
  if (documentRow.user_id !== doc.userId) {
    throw new Error(
      `ingestDocument: document ${doc.documentId} belongs to user ${documentRow.user_id}, not ${doc.userId}`
    );
  }

  await setProcessingStatus(supabase, doc.documentId, {
    processing_status: "processing",
    processing_error: null,
  });

  try {
    const chunks = chunkText(doc.text, chunkOptions);

    if (chunks.length === 0) {
      const message = "Документ не содержит текста для обработки.";
      await setProcessingStatus(supabase, doc.documentId, {
        processing_status: "error",
        processing_error: message,
      });
      throw new Error(`ingestDocument: ${message} (document ${doc.documentId})`);
    }

    const vectors = await embeddingsProvider.embed(chunks.map((c) => c.content));
    if (vectors.length !== chunks.length) {
      // embedInBatches (lib/ai/embed-batch.ts) guarantees this can't
      // happen for the real providers, but a misbehaving/mocked provider
      // implementation could still violate the contract -- fail loudly
      // rather than silently misaligning chunk_index <-> embedding.
      throw new Error(
        `ingestDocument: embeddings provider returned ${vectors.length} vectors for ${chunks.length} chunks`
      );
    }

    // Delete-before-insert: REQUIRED for idempotent re-sync, per the
    // document_chunks migration's table comment. Doing the delete and
    // insert as two separate statements (not a single transaction) is a
    // deliberate, acceptable tradeoff here: Supabase's PostgREST-based
    // client doesn't expose multi-statement transactions, and the
    // realistic failure mode (delete succeeds, insert fails) already
    // leaves the document correctly marked 'error' by the catch block
    // below with zero (not stale) chunks -- which is safe for
    // match_document_chunks (nothing to return) even if not the ideal UX.
    const { error: deleteError } = await supabase
      .from("document_chunks")
      .delete()
      .eq("document_id", doc.documentId);
    if (deleteError) {
      throw new Error(`ingestDocument: failed to delete existing chunks: ${deleteError.message}`);
    }

    const rows = chunks.map((chunk, i) => ({
      document_id: doc.documentId,
      chunk_index: chunk.index,
      content: chunk.content,
      // page_number is left null: the normalized-document contract this
      // pipeline receives ({ documentId, userId, title, text }) is a flat
      // string with no page markers (see CLAUDE.md's DocumentSource
      // interface) -- only chunk_position (ordinal) is available for
      // citation until/unless document-sources-specialist starts passing
      // page boundaries through for PDF sources.
      page_number: null as number | null,
      chunk_position: chunk.index,
      embedding: vectors[i],
      embedding_provider: embeddingsProvider.providerName,
      embedding_model: embeddingsProvider.modelName,
    }));

    const { error: insertError } = await supabase.from("document_chunks").insert(rows);
    if (insertError) {
      throw new Error(`ingestDocument: failed to insert chunks: ${insertError.message}`);
    }

    // Logged (not just stored) per CLAUDE.md: "хранит (или логирует),
    // каким провайдером/моделью были сделаны embeddings" -- this line is
    // what makes a provider switch visible in server logs even before
    // anyone queries document_chunks.embedding_provider directly.
    console.info(
      `ingestDocument: embedded ${chunks.length} chunks for document ${doc.documentId} ("${doc.title}") using ${embeddingsProvider.providerName}/${embeddingsProvider.modelName}`
    );

    await setProcessingStatus(supabase, doc.documentId, {
      processing_status: "ready",
      processing_error: null,
      // manual_upload has nothing to re-sync, so last_synced_at stays null
      // for it (see the documents migration's column comment); every other
      // source stamps it on each successful (re-)ingest.
      ...(documentRow.source_type !== "manual_upload"
        ? { last_synced_at: new Date().toISOString() }
        : {}),
    });

    return {
      documentId: doc.documentId,
      chunkCount: chunks.length,
      embeddingProvider: embeddingsProvider.providerName,
      embeddingModel: embeddingsProvider.modelName,
    };
  } catch (err) {
    const message = err instanceof AIProviderError ? err.message : err instanceof Error ? err.message : String(err);
    await setProcessingStatus(supabase, doc.documentId, {
      processing_status: "error",
      processing_error: message,
    });
    throw err;
  }
}

/**
 * Convenience wrapper wiring in the real service-role Supabase client and
 * the AI_PROVIDER-selected EmbeddingsProvider -- what document-sources-
 * specialist's adapters should actually call after normalizing a document.
 * Kept separate from ingestDocument() so the core pipeline stays
 * unit-testable with fakes (see lib/ingestion/__tests__/ingest.test.ts).
 */
export async function ingestDocumentWithDefaultProviders(
  doc: NormalizedDocument,
  chunkOptions?: ChunkOptions
): Promise<IngestResult> {
  // getServiceRoleClient() throwing here (missing Supabase env vars) is a
  // deeper misconfiguration than a missing/invalid AI provider credential:
  // without a DB client there is no row we could even flip to 'error', so
  // there's nothing to catch this into -- let it surface as-is, same as
  // before.
  const supabase = getServiceRoleClient();

  let embeddingsProvider: EmbeddingsProvider;
  try {
    // Per-user, bring-your-own-key (see lib/ai/index.ts): doc.userId is
    // already part of this function's NormalizedDocument contract (the
    // document's owner), so it's threaded straight through -- there is no
    // more process-global "the" embeddings provider.
    embeddingsProvider = await getEmbeddingsProvider(doc.userId, supabase);
  } catch (err) {
    // getEmbeddingsProvider() (via getAIProviders()) rejects when doc.userId
    // has no active AI provider configured, or their active provider's
    // credential(s) are missing (AIProviderError{kind:"no_credentials"} --
    // see lib/ai/index.ts) -- or, less commonly, on any other AI-provider
    // failure. Before an earlier fix (back when this was the global-env
    // AI_PROVIDER path), an equivalent throw happened while evaluating an
    // eagerly-computed argument to ingestDocument(doc, { ...
    // embeddingsProvider: getEmbeddingsProvider() }, ...) -- i.e. BEFORE
    // ingestDocument()'s own try/catch (which flips
    // documents.processing_status to 'error') ever started running. The
    // document row was left stuck in 'pending' forever with
    // processing_error: null, invisible to both the UI and the user
    // (reproduced live by qa-reviewer against POST /api/sources/upload).
    // Fix: get the provider inside a try of our own, and on failure perform
    // the exact same status transition ingestDocument()'s catch block would
    // have performed, before rethrowing so the caller (document-sources-
    // specialist's route handlers) still sees the failure -- e.g. a user
    // with no AI provider configured yet who tries to upload a document
    // sees a clear processing_error message instead of a document stuck in
    // 'pending' forever.
    const message = err instanceof Error ? err.message : String(err);
    await setProcessingStatus(supabase, doc.documentId, {
      processing_status: "error",
      processing_error: message,
    });
    throw err;
  }

  return ingestDocument(doc, { supabase, embeddingsProvider }, chunkOptions);
}
