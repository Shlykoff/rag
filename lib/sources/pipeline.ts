// lib/sources/pipeline.ts
//
// The one place (besides lib/ingestion/ingest.ts itself) that writes to
// the `documents` table or uploads to the `documents` Storage bucket on
// behalf of a source adapter. Every API route in app/api/sources/ funnels
// through here so "create a document" and "refresh an existing one" share
// identical Storage-path + ingest wiring -- duplicating this per-route
// would be an easy place for the "<user_id>/..." Storage path convention
// (enforced by the documents_storage_path_prefixed_with_user_id DB
// constraint) or the delete-before-insert ingest contract to quietly drift
// between sources.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ingestDocumentWithDefaultProviders, type IngestResult } from "../ingestion/ingest";
import type { DocumentSourceType } from "./types";

export interface StoredObject {
  /** Appended after `${userId}/${documentId}/` -- e.g. "original.pdf" (manual_upload) or "content.txt" (every other source's cached text extraction). */
  suffix: string;
  content: Buffer | string;
  contentType: string;
}

async function uploadObject(
  supabase: SupabaseClient,
  userId: string,
  documentId: string,
  object: StoredObject
): Promise<string> {
  const path = `${userId}/${documentId}/${object.suffix}`;
  const { error } = await supabase.storage.from("documents").upload(path, object.content, {
    contentType: object.contentType,
    upsert: true, // re-sync overwrites the previous object at the same path rather than erroring
  });
  if (error) {
    throw new Error(`lib/sources/pipeline: failed to upload ${path} to the documents bucket: ${error.message}`);
  }
  return path;
}

export interface CreateDocumentParams {
  userId: string;
  title: string;
  sourceType: DocumentSourceType;
  sourceRef: string | null;
  text: string;
  object: StoredObject;
}

/** Inserts a new `documents` row (starts 'pending'), uploads its Storage object, points storage_path at it, then runs the full chunk/embed pipeline (lib/ingestion/ingest.ts). Used by every source's first-time import. */
export async function createDocumentFromSource(
  supabase: SupabaseClient,
  params: CreateDocumentParams
): Promise<IngestResult & { documentId: string }> {
  const { data, error } = await supabase
    .from("documents")
    .insert({
      user_id: params.userId,
      title: params.title,
      source_type: params.sourceType,
      source_ref: params.sourceRef,
      processing_status: "pending",
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`createDocumentFromSource: failed to insert documents row: ${error?.message ?? "no row returned"}`);
  }
  const documentId = data.id as string;

  // Storage path depends on documentId, which only exists after the insert
  // above -- this ordering (insert row -> upload object -> set
  // storage_path -> ingest) is why NormalizedDocument.storagePath (see
  // lib/sources/types.ts) is always undefined coming out of an adapter.
  const storagePath = await uploadObject(supabase, params.userId, documentId, params.object);

  const { error: updateError } = await supabase.from("documents").update({ storage_path: storagePath }).eq("id", documentId);
  if (updateError) {
    throw new Error(`createDocumentFromSource: failed to set storage_path for ${documentId}: ${updateError.message}`);
  }

  // ingestDocumentWithDefaultProviders's IngestResult already carries
  // `documentId` (see lib/ingestion/ingest.ts) -- no need to re-attach it.
  return ingestDocumentWithDefaultProviders({
    documentId,
    userId: params.userId,
    title: params.title,
    text: params.text,
  });
}

export interface RefreshDocumentParams {
  documentId: string;
  userId: string;
  title: string;
  text: string;
  object: StoredObject;
}

/** Re-uploads a Refreshed source's content over its existing Storage object (same path, `upsert: true`) and re-runs ingest -- delete-before-insert inside ingestDocument() is what makes this safe to call repeatedly. Used by every non-manual_upload source's "Refresh" path (and by upsertDocumentFromSource below, for a re-import of an already-known external ref). */
export async function refreshDocumentFromSource(
  supabase: SupabaseClient,
  params: RefreshDocumentParams
): Promise<IngestResult> {
  const storagePath = await uploadObject(supabase, params.userId, params.documentId, params.object);

  const { error: updateError } = await supabase
    .from("documents")
    .update({ title: params.title, storage_path: storagePath })
    .eq("id", params.documentId)
    .eq("user_id", params.userId);
  if (updateError) {
    throw new Error(`refreshDocumentFromSource: failed to update document ${params.documentId}: ${updateError.message}`);
  }

  return ingestDocumentWithDefaultProviders({
    documentId: params.documentId,
    userId: params.userId,
    title: params.title,
    text: params.text,
  });
}

export interface UpsertDocumentParams {
  userId: string;
  title: string;
  sourceType: DocumentSourceType;
  /** Required (non-null) here, unlike CreateDocumentParams -- this is the lookup key for "does a document for this external ref already exist", which only makes sense for sources that have one (Notion/URL/Drive, never manual_upload). */
  sourceRef: string;
  text: string;
  object: StoredObject;
}

/**
 * Create-or-refresh keyed by (userId, sourceType, sourceRef): what
 * app/api/sources/{notion,url,google-drive}/route.ts call, so importing
 * the same Notion page / URL / Drive file a second time updates the
 * existing document in place instead of creating a duplicate row every
 * time a user re-submits the same source (a very likely real-world click
 * pattern -- e.g. re-pasting the same URL after it's already been added).
 */
export async function upsertDocumentFromSource(
  supabase: SupabaseClient,
  params: UpsertDocumentParams
): Promise<IngestResult & { documentId: string; created: boolean }> {
  const { data: existing, error: lookupError } = await supabase
    .from("documents")
    .select("id")
    .eq("user_id", params.userId)
    .eq("source_type", params.sourceType)
    .eq("source_ref", params.sourceRef)
    .maybeSingle<{ id: string }>();
  if (lookupError) {
    throw new Error(`upsertDocumentFromSource: failed to look up existing document: ${lookupError.message}`);
  }

  if (existing) {
    const result = await refreshDocumentFromSource(supabase, {
      documentId: existing.id,
      userId: params.userId,
      title: params.title,
      text: params.text,
      object: params.object,
    });
    // result.documentId already equals existing.id (refreshDocumentFromSource
    // doesn't change which row it writes to) -- no need to re-attach it.
    return { ...result, created: false };
  }

  const result = await createDocumentFromSource(supabase, params);
  return { ...result, created: true };
}
