// lib/sources/types.ts
//
// The common contract every source adapter (manual-upload/notion/url/
// google-drive) normalizes down to before this project's shared ingestion
// pipeline (lib/ingestion/ingest.ts) ever sees a document -- see CLAUDE.md
// "Источники документов" and the `documents` table migration. Nothing
// outside lib/sources/ (API routes) should reach into a source's own
// concrete implementation directly; they go through this shape plus
// lib/sources/pipeline.ts, which is what actually persists it.

export type DocumentSourceType = "manual_upload" | "notion" | "url" | "google_drive";

/**
 * What every adapter produces after fetching + extracting text from its
 * origin, matching the `{ title, text, sourceType, sourceRef, storagePath?
 * }` shape from CLAUDE.md. `storagePath` is optional and, in this
 * implementation, always left undefined by adapters: the Storage object
 * path is "<project_id>/<document_id>/..." (see the documents table
 * migration), and document_id doesn't exist yet at the point an adapter
 * runs -- lib/sources/pipeline.ts computes and fills it in once the
 * `documents` row has been inserted. The field is kept on this interface
 * for contract-compatibility (an adapter that already knows its own
 * desired Storage layout ahead of time is free to set it) rather than
 * removed.
 */
export interface NormalizedDocument {
  title: string;
  text: string;
  sourceType: DocumentSourceType;
  /**
   * External identifier used to re-fetch the document on "Refresh": the
   * Notion page/database id, the public URL (after following redirects --
   * see lib/sources/url.ts), or the Google Drive file id. null only for
   * manual_upload, which has nothing external to re-fetch (matches the
   * `documents_source_ref_required_unless_manual` DB constraint).
   */
  sourceRef: string | null;
  storagePath?: string;
}

/**
 * The `DocumentSource` interface CLAUDE.md's "Источники документов" design
 * section calls for, named explicitly (rather than left as an implicit
 * convention every adapter happens to follow) so it's checkable in code.
 *
 * Deliberately expressed as one shared shape for adapter *output* only, not
 * a unified method signature across all four adapters' input: each
 * adapter's fetch function (importNotionDocument/importUrlDocument/
 * importSingleDriveFile/processManualUpload) necessarily takes different
 * input (a Notion page needs `{supabase, ownerUserId, pageUrl}`, a bare URL
 * needs `{url}`, an upload needs raw bytes, a Drive file needs `{supabase,
 * ownerUserId, fileId}`). Forcing one signature across all four would mean
 * every adapter accepts a union of parameters it mostly ignores; instead,
 * every adapter's fetch function is typed `(...): Promise<DocumentSource>`
 * (or a value assignable to it), so `lib/ingestion/ingest.ts`/
 * `lib/sources/pipeline.ts` can treat the output of any of them identically
 * regardless of where a document came from.
 */
export type DocumentSource = NormalizedDocument;
