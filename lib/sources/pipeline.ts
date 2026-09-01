// lib/sources/pipeline.ts
//
// The one place (besides lib/ingestion/ingest.ts itself) that writes to
// the `documents` table or uploads to the `documents` Storage bucket on
// behalf of a source adapter. Every API route in app/api/sources/ funnels
// through here so "create a document" and "refresh an existing one" share
// identical Storage-path + ingest wiring -- duplicating this per-route
// would be an easy place for the "<project_id>/..." Storage path
// convention (enforced by the
// documents_storage_path_prefixed_with_project_id DB constraint) or the
// delete-before-insert ingest contract to quietly drift between sources.
//
// Documents are project-scoped, not user-scoped -- every function below
// takes a `projectId` (what Storage paths/the `documents` row/dedup lookups
// key off) alongside an `ownerUserId` (the project's owner, threaded
// through to lib/ingestion/ingest.ts purely so it can resolve the right
// account-level AI-provider credentials -- see that module's own header).
// Callers (the app/api/sources/** routes) are responsible for independently
// verifying `projectId` actually belongs to the authenticated caller
// BEFORE calling anything here -- this module trusts its caller, the same
// trust boundary lib/ingestion/ingest.ts documents for itself.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ingestDocumentWithDefaultProviders, type IngestResult } from "../ingestion/ingest";
import type { DocumentSourceType } from "./types";
import { importUrlDocument } from "./url";
import { importNotionDocument } from "./notion";
import { importSingleDriveFile } from "./google-drive";

export interface StoredObject {
  /** Appended after `${projectId}/${documentId}/` -- e.g. "original.pdf" (manual_upload) or "content.txt" (every other source's cached text extraction). */
  suffix: string;
  content: Buffer | string;
  contentType: string;
}

async function uploadObject(
  supabase: SupabaseClient,
  projectId: string,
  documentId: string,
  object: StoredObject
): Promise<string> {
  const path = `${projectId}/${documentId}/${object.suffix}`;
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
  projectId: string;
  /** The project's owner -- see this module's header. */
  ownerUserId: string;
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
      project_id: params.projectId,
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
  // storage_path -> ingest) is why NormalizedDocument.storagePath is
  // always undefined coming out of an adapter (see lib/sources/types.ts).
  const storagePath = await uploadObject(supabase, params.projectId, documentId, params.object);

  const { error: updateError } = await supabase.from("documents").update({ storage_path: storagePath }).eq("id", documentId);
  if (updateError) {
    throw new Error(`createDocumentFromSource: failed to set storage_path for ${documentId}: ${updateError.message}`);
  }

  // ingestDocumentWithDefaultProviders's IngestResult already carries
  // `documentId` (see lib/ingestion/ingest.ts) -- no need to re-attach it.
  return ingestDocumentWithDefaultProviders({
    documentId,
    projectId: params.projectId,
    ownerUserId: params.ownerUserId,
    title: params.title,
    text: params.text,
  });
}

export interface RefreshDocumentParams {
  documentId: string;
  projectId: string;
  /** The project's owner -- see this module's header. */
  ownerUserId: string;
  title: string;
  text: string;
  object: StoredObject;
}

/** Re-uploads a Refreshed source's content over its existing Storage object (same path, `upsert: true`) and re-runs ingest -- delete-before-insert inside ingestDocument() is what makes this safe to call repeatedly. Used by every non-manual_upload source's "Refresh" path (and by upsertDocumentFromSource below, for a re-import of an already-known external ref). */
export async function refreshDocumentFromSource(
  supabase: SupabaseClient,
  params: RefreshDocumentParams
): Promise<IngestResult> {
  const storagePath = await uploadObject(supabase, params.projectId, params.documentId, params.object);

  const { error: updateError } = await supabase
    .from("documents")
    .update({ title: params.title, storage_path: storagePath })
    .eq("id", params.documentId)
    .eq("project_id", params.projectId);
  if (updateError) {
    throw new Error(`refreshDocumentFromSource: failed to update document ${params.documentId}: ${updateError.message}`);
  }

  return ingestDocumentWithDefaultProviders({
    documentId: params.documentId,
    projectId: params.projectId,
    ownerUserId: params.ownerUserId,
    title: params.title,
    text: params.text,
  });
}

export interface UpsertDocumentParams {
  projectId: string;
  /** The project's owner -- see this module's header. */
  ownerUserId: string;
  title: string;
  sourceType: DocumentSourceType;
  /** Required (non-null) here, unlike CreateDocumentParams -- this is the lookup key for "does a document for this external ref already exist", which only makes sense for sources that have one (Notion/URL/Drive, never manual_upload). */
  sourceRef: string;
  text: string;
  object: StoredObject;
}

/**
 * Create-or-refresh keyed by (projectId, sourceType, sourceRef): what
 * app/api/sources/{notion,url,google-drive}/route.ts call, so importing
 * the same Notion page / URL / Drive file a second time into the SAME
 * project updates the existing document in place instead of creating a
 * duplicate row every time the same source is re-submitted (a very likely
 * real-world click pattern -- e.g. re-pasting the same URL after it's
 * already been added). Scoped to the project (not the account) so the same
 * external source can independently be imported into two different
 * projects owned by the same user without one "refresh" clobbering the
 * other's document.
 */
export async function upsertDocumentFromSource(
  supabase: SupabaseClient,
  params: UpsertDocumentParams
): Promise<IngestResult & { documentId: string; created: boolean }> {
  const { data: existing, error: lookupError } = await supabase
    .from("documents")
    .select("id")
    .eq("project_id", params.projectId)
    .eq("source_type", params.sourceType)
    .eq("source_ref", params.sourceRef)
    .maybeSingle<{ id: string }>();
  if (lookupError) {
    throw new Error(`upsertDocumentFromSource: failed to look up existing document: ${lookupError.message}`);
  }

  if (existing) {
    const result = await refreshDocumentFromSource(supabase, {
      documentId: existing.id,
      projectId: params.projectId,
      ownerUserId: params.ownerUserId,
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

export interface RefetchContext {
  /** The credential owner -- source credentials stay account-level (see lib/sources/credentials.ts), never project-scoped. */
  ownerUserId: string;
}

export interface RefetchResult {
  title: string;
  text: string;
  object: StoredObject;
}

/**
 * Uniform re-fetch entry point for "Refresh"
 * (app/api/sources/[documentId]/refresh/route.ts): dispatches to the
 * adapter matching `sourceType` and normalizes each one's differently-
 * shaped result into the one shape refreshDocumentFromSource actually
 * needs (extracted text + a StoredObject to re-upload alongside it).
 * Mirrors lib/ai/index.ts's PROVIDER_REGISTRY dispatch-by-key pattern --
 * one lookup table instead of the caller hand-branching on a string union.
 * `manual_upload` is deliberately not a valid input here: it has nothing
 * external to re-fetch, so the route rejects it with its own 400 BEFORE
 * ever reaching this function -- see that route's comment for why that
 * check stays there rather than being folded into this dispatcher.
 */
export async function refetchByRef(
  sourceType: "notion" | "url" | "google_drive",
  sourceRef: string,
  supabase: SupabaseClient,
  ctx: RefetchContext
): Promise<RefetchResult> {
  if (sourceType === "url") {
    const normalized = await importUrlDocument(sourceRef);
    return {
      title: normalized.title,
      text: normalized.text,
      object: { suffix: "content.txt", content: normalized.text, contentType: "text/plain; charset=utf-8" },
    };
  }
  if (sourceType === "notion") {
    const normalized = await importNotionDocument(supabase, ctx.ownerUserId, sourceRef);
    return {
      title: normalized.title,
      text: normalized.text,
      object: { suffix: "content.txt", content: normalized.text, contentType: "text/plain; charset=utf-8" },
    };
  }
  // google_drive: source_ref on a per-file document row is the Drive FILE
  // id, not the folder id -- refreshing one file re-downloads/exports just
  // that file rather than re-listing (and re-importing every file in) the
  // whole folder. Re-syncing the whole folder (picking up newly added
  // files) is POST /api/sources/google-drive's job, not this endpoint's.
  const normalized = await importSingleDriveFile(supabase, ctx.ownerUserId, sourceRef);
  return {
    title: normalized.title,
    text: normalized.text,
    object: { suffix: "content.txt", content: normalized.text, contentType: "text/plain; charset=utf-8" },
  };
}
