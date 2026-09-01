// lib/ingestion/ingest.ts
//
// The ingestion pipeline: chunk -> embed -> delete-before-insert into
// document_chunks -> flip documents.processing_status. Takes an already-
// normalized document ({ documentId, projectId, ownerUserId, title, text })
// -- this module never fetches from Notion/URL/Drive/disk itself, that's
// document-sources-specialist's job (see CLAUDE.md). Called once per
// initial ingest AND once per manual "Refresh" re-sync; both paths go
// through this exact same function, which is what makes re-sync
// idempotent (delete-before-insert, not insert-or-update) -- see the
// document_chunks migration's table comment for why that contract is
// load-bearing (a shrinking document must not leave orphaned trailing
// chunks behind).
//
// Documents belong to a project, not directly to a user -- `projectId` is
// what's verified against the document row below and what Storage
// paths/RPCs key off. `ownerUserId` (the project's owner) is carried
// alongside it so this module can hand it to lib/ai/index.ts's
// getEmbeddingsProvider({projectId, ownerUserId}, supabase): AI-provider
// credentials stay account-level (lib/ai/credentials.ts), so building an
// embeddings provider for this project still needs to know whose stored
// key to decrypt.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EmbeddingsProvider } from "../ai/types";
import { AIProviderError } from "../ai/errors";
import { chunkText, type ChunkOptions } from "./chunk";
import { getServiceRoleClient } from "../supabase/service-client";
import { getEmbeddingsProvider } from "../ai";

export interface NormalizedDocument {
  documentId: string;
  projectId: string;
  /** The project's owner -- see the module header for why this module needs it in addition to projectId. */
  ownerUserId: string;
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
  project_id: string;
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
    .select("id, project_id, source_type")
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
  // projectId -- a mismatch here means the caller (document-sources-
  // specialist / an API route) has a bug, and we'd rather fail loudly than
  // embed one project's content under another project's document row.
  if (documentRow.project_id !== doc.projectId) {
    throw new Error(
      `ingestDocument: document ${doc.documentId} belongs to project ${documentRow.project_id}, not ${doc.projectId}`
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

    // Delete-before-insert: required for idempotent re-sync, per the
    // document_chunks migration's table comment. Runs after a successful
    // embed, not concurrently with it: running the delete alongside the
    // embed attempt would mean any embed failure (expired key, transient
    // network blip, provider rate limit) instantly wipes the existing,
    // still-servable chunk set, making the document unsearchable instead of
    // leaving it stale-but-searchable. Delete and insert are two separate
    // statements, not one transaction -- Supabase's PostgREST-based client
    // doesn't expose multi-statement transactions, and the realistic
    // failure mode (delete succeeds, insert fails) already leaves the
    // document correctly marked 'error' by the catch block below with zero
    // (not stale) chunks, which is safe for match_document_chunks even if
    // not the ideal UX.
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
      // pipeline receives is a flat string with no page markers (see
      // CLAUDE.md's DocumentSource interface) -- only chunk_position
      // (ordinal) is available for citation until document-sources-
      // specialist starts passing page boundaries through for PDF sources.
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
  // let it surface as-is.
  const supabase = getServiceRoleClient();

  let embeddingsProvider: EmbeddingsProvider;
  try {
    // doc.projectId / doc.ownerUserId are part of this function's
    // NormalizedDocument contract and threaded straight through -- there is
    // no process-global "the" embeddings provider.
    embeddingsProvider = await getEmbeddingsProvider({ projectId: doc.projectId, ownerUserId: doc.ownerUserId }, supabase);
  } catch (err) {
    // getEmbeddingsProvider() (via getAIProviders()) rejects when
    // doc.projectId has no active AI provider configured, or its owner's
    // credential(s) for that provider are missing
    // (AIProviderError{kind:"no_credentials"} -- see lib/ai/index.ts), or
    // on any other AI-provider failure. This has to be caught here, in a
    // try of our own, rather than left to ingestDocument()'s try/catch:
    // that catch only starts running once ingestDocument() is called, so a
    // rejection while resolving the embeddings provider argument would
    // otherwise never flip documents.processing_status to 'error' at all,
    // leaving the document stuck in 'pending' with no visible error. This
    // performs the same status transition ingestDocument()'s catch block
    // would, then rethrows so the caller still sees the failure.
    const message = err instanceof Error ? err.message : String(err);
    await setProcessingStatus(supabase, doc.documentId, {
      processing_status: "error",
      processing_error: message,
    });
    throw err;
  }

  return ingestDocument(doc, { supabase, embeddingsProvider }, chunkOptions);
}
