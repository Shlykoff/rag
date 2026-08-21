// app/api/sources/[documentId]/refresh/route.ts
//
// Manual re-sync ("Refresh" button) for one existing document. Re-fetches
// its content from the external source (looked up via
// documents.source_type/source_ref) and re-runs the full ingest pipeline.
// Deliberately NOT automatic -- no polling, no webhooks (CLAUDE.md/README
// "Ре-синхронизация... по кнопке Refresh вручную"). manual_upload
// documents have nothing external to refresh (400).
//
// PROJECTS PIVOT: `documents` no longer carries a `user_id` column (see
// the documents migration) -- this route fetches the document's
// `project_id` first, then verifies that project's ownership via the
// RLS-scoped session client (verifyProjectOwnership()), and only THEN
// checks the (now project-keyed) rate limit -- a deliberate reordering
// from the pre-pivot version (which rate-limited before the DB lookup,
// back when the limiter was keyed by the authenticated user id alone and
// didn't need the document row first). Still strictly before any
// network/AI-provider work, preserving CLAUDE.md rule 4's intent.
//
// Request contract:
//   POST /api/sources/{documentId}/refresh
//   -> 401 { error: "unauthorized" }
//   -> 404 { error: "not_found" } -- no such document, or its project
//      belongs to another user (same response for both -- see comment
//      below)
//   -> 429 { error: "rate_limited", message, retryAfterMs } -- Retry-After header set, in seconds
//   -> 400 { error: "invalid_request", details } -- manual_upload document
//   -> 400/401/403/422/502 { error: <SourceError.kind>, message } -- see
//      lib/sources/http-error.ts
//   -> 422 { error: "no_credentials", message } if this project has no
//      active AI provider configured yet (or its owner's stored
//      credential(s) are missing) -- see lib/ai/index.ts's getAIProviders()
//      and lib/sources/http-error.ts's sourceErrorResponse(), same contract
//      as app/api/chat/route.ts's 422. Deliberately not logged via
//      console.error -- expected per-project state, not a server fault.
//   -> 200 { documentId, chunkCount, status: "ready" }

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceRoleClient } from "@/lib/supabase/service-client";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient, verifyProjectOwnership } from "@/lib/supabase/server-client";
import { refreshDocumentFromSource, type StoredObject } from "@/lib/sources/pipeline";
import { importUrlDocument } from "@/lib/sources/url";
import { importNotionDocument } from "@/lib/sources/notion";
import { importSingleDriveFile } from "@/lib/sources/google-drive";
import { sourceErrorResponse, sourceIngestRateLimitedResponse } from "@/lib/sources/http-error";
import { checkSourceIngestRateLimit } from "@/lib/rate-limit/source-ingest-rate-limiter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface DocumentRow {
  id: string;
  project_id: string;
  title: string;
  source_type: "manual_upload" | "notion" | "url" | "google_drive";
  source_ref: string | null;
}

async function refetchFromSource(
  supabase: SupabaseClient,
  /** The credential owner -- source credentials stay account-level (see lib/sources/credentials.ts), never project-scoped. */
  ownerUserId: string,
  sourceType: "notion" | "url" | "google_drive",
  sourceRef: string
): Promise<{ title: string; text: string; object: StoredObject }> {
  if (sourceType === "url") {
    const normalized = await importUrlDocument(sourceRef);
    return {
      title: normalized.title,
      text: normalized.text,
      object: { suffix: "content.txt", content: normalized.text, contentType: "text/plain; charset=utf-8" },
    };
  }
  if (sourceType === "notion") {
    const normalized = await importNotionDocument(supabase, ownerUserId, sourceRef);
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
  const normalized = await importSingleDriveFile(supabase, ownerUserId, sourceRef);
  return {
    title: normalized.title,
    text: normalized.text,
    object: { suffix: "content.txt", content: normalized.text, contentType: "text/plain; charset=utf-8" },
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ documentId: string }> }
): Promise<Response> {
  const { documentId } = await params;

  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const supabase = getServiceRoleClient();
  const { data: doc, error } = await supabase
    .from("documents")
    .select("id, project_id, title, source_type, source_ref")
    .eq("id", documentId)
    .maybeSingle<DocumentRow>();
  if (error) {
    console.error(`refresh route: failed to load document ${documentId}:`, error);
    return Response.json({ error: "internal_error", message: "Не удалось загрузить документ." }, { status: 500 });
  }
  if (!doc) {
    // Identical response for "doesn't exist" and "project belongs to
    // someone else" -- don't let an authenticated-but-unauthorized caller
    // distinguish the two.
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const owned = await verifyProjectOwnership(authClient, doc.project_id);
  if (!owned) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  // Rate limit check happens right after the ownership check (which
  // needed the document row's project_id first) but BEFORE re-fetching
  // from the external source or calling any AI-provider work --
  // CLAUDE.md rule 4. Keyed by projectId now, not userId. See
  // lib/rate-limit/source-ingest-rate-limiter.ts's module comment.
  const rateLimit = checkSourceIngestRateLimit(doc.project_id);
  if (!rateLimit.allowed) {
    return sourceIngestRateLimitedResponse(rateLimit);
  }

  if (doc.source_type === "manual_upload") {
    return Response.json(
      { error: "invalid_request", details: "manual_upload documents have no external source to refresh." },
      { status: 400 }
    );
  }
  if (!doc.source_ref) {
    // Should be unreachable -- documents_source_ref_required_unless_manual
    // guarantees every non-manual_upload row has a source_ref -- but fail
    // clearly rather than passing `null` into a fetch call if it ever is.
    return Response.json({ error: "internal_error", message: "Документ повреждён: отсутствует source_ref." }, { status: 500 });
  }

  try {
    const { title, text, object } = await refetchFromSource(supabase, user.id, doc.source_type, doc.source_ref);
    const result = await refreshDocumentFromSource(supabase, {
      documentId: doc.id,
      projectId: doc.project_id,
      ownerUserId: user.id,
      title: title || doc.title,
      text,
      object,
    });
    return Response.json({ documentId: doc.id, chunkCount: result.chunkCount, status: "ready" }, { status: 200 });
  } catch (err) {
    return sourceErrorResponse(err);
  }
}
