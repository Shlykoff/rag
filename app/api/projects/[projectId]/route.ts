// app/api/projects/[projectId]/route.ts
//
// Read/rename/delete ONE project the caller owns. Same auth -> ownership
// check (404, not 403, on mismatch -- see verifyProjectOwnership's own
// comment) -> service-role client for the actual work -> JSON response
// shape as every other single-resource route in this codebase
// (app/api/sources/[documentId]/route.ts, .../refresh/route.ts).
//
// Request contract:
//   GET /api/projects/{projectId}
//   -> 401 { error: "unauthorized" }
//   -> 404 { error: "not_found" }   -- missing OR belongs to another user,
//      deliberately identical response for both (an authenticated-but-
//      unauthorized caller must not be able to distinguish the two)
//   -> 200 { project: ProjectDTO }   -- see ./../shared.ts
//
//   PATCH /api/projects/{projectId}
//   body: { name: string }          -- trimmed, 1..200 chars; the only
//      field this endpoint supports today (active_ai_provider has its own
//      dedicated endpoint, see ./model/route.ts, per CLAUDE.md's explicit
//      "connect a provider is account-level, which one a project uses is
//      project-level" split -- renaming and re-modeling a project are
//      different concerns with different validation, kept as separate
//      routes rather than one do-everything PATCH)
//   -> 401 { error: "unauthorized" }
//   -> 404 { error: "not_found" }
//   -> 400 { error: "invalid_request", details }
//   -> 200 { project: ProjectDTO }
//
//   DELETE /api/projects/{projectId}
//   -> 401 { error: "unauthorized" }
//   -> 404 { error: "not_found" }
//   -> 500 { error: "storage_cleanup_failed", message } -- Storage objects
//      under "<projectId>/" could not be fully listed/removed; the project
//      row is deliberately NOT deleted in this case (see the storage
//      cleanup comment below for why this differs from the single-document
//      delete route's best-effort-after-the-fact posture) -- retry the
//      DELETE once the underlying Storage issue clears.
//   -> 200 { projectId, status: "deleted" }

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getServiceRoleClient } from "@/lib/supabase/service-client";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient, verifyProjectOwnership } from "@/lib/supabase/server-client";
import { PROJECT_SELECT_COLUMNS, ProjectNameSchema, toProjectDTO, type ProjectRow } from "../shared";
import { isUuidShape } from "@/lib/validation/uuid";
import { parseJsonBody } from "@/lib/http/parse-json-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UpdateProjectBodySchema = z.object({ name: ProjectNameSchema });

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  // Shape-check before ever touching the DB: a syntactically-invalid uuid
  // reaching `.eq("id", projectId)` would come back as an uncaught Postgres
  // "invalid input syntax for type uuid" (a raw 500) instead of this
  // route's own documented 404. See lib/validation/uuid.ts's header for why
  // this is a shape check, not the stricter `z.string().uuid()`.
  if (!isUuidShape(projectId)) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const owned = await verifyProjectOwnership(authClient, projectId);
  if (!owned) return Response.json({ error: "not_found" }, { status: 404 });

  const supabase = getServiceRoleClient();
  const { data, error } = await supabase.from("projects").select(PROJECT_SELECT_COLUMNS).eq("id", projectId).maybeSingle();
  if (error) {
    console.error(`GET /api/projects/${projectId}: failed to load project:`, error);
    return Response.json({ error: "internal_error", message: "Не удалось загрузить проект." }, { status: 500 });
  }
  if (!data) {
    // Ownership check above already passed -- this only happens if the
    // project was deleted by a concurrent request in the gap between that
    // check and this SELECT. Same "gone by the time we got here" outcome
    // as the delete race below, same response.
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  return Response.json({ project: toProjectDTO(data as ProjectRow) }, { status: 200 });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  // Shape-check before touching the DB -- see the GET handler above.
  if (!isUuidShape(projectId)) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const owned = await verifyProjectOwnership(authClient, projectId);
  if (!owned) return Response.json({ error: "not_found" }, { status: 404 });

  const parsed = await parseJsonBody(request, UpdateProjectBodySchema);
  if ("errorResponse" in parsed) return parsed.errorResponse;

  const supabase = getServiceRoleClient();
  const { data, error } = await supabase
    .from("projects")
    .update({ name: parsed.data.name })
    .eq("id", projectId)
    .select(PROJECT_SELECT_COLUMNS)
    .maybeSingle();
  if (error) {
    console.error(`PATCH /api/projects/${projectId}: failed to update project:`, error);
    return Response.json({ error: "internal_error", message: "Не удалось обновить проект." }, { status: 500 });
  }
  if (!data) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  return Response.json({ project: toProjectDTO(data as ProjectRow) }, { status: 200 });
}

interface StorageEntry {
  id: string | null;
  name: string;
}

// Well above any realistic per-project document/object count for this
// MVP's demo scale -- a real cursor-based pagination loop past this would
// be needed for a project with thousands of documents, out of scope here
// (mirrors this project's other explicitly-bounded MVP tradeoffs, e.g.
// source-ingest-rate-limiter.ts's single-process limitation).
const STORAGE_LIST_PAGE_SIZE = 1000;

/**
 * Enumerates every actual object (never a pseudo-folder entry) under
 * "<projectId>/" in the "documents" Storage bucket, by walking the exact
 * two-level path convention every document is written under
 * ("<projectId>/<documentId>/<suffix>" -- see
 * lib/sources/pipeline.ts's uploadObject()): list the project "folder" to
 * discover per-document sub-folders, then list each of those to discover
 * the actual object names.
 *
 * Deliberately does NOT derive paths from the `documents` table (unlike
 * the single-document delete route, which already knows one row's
 * storage_path column) -- listing Storage directly also catches any
 * object that might exist without a live `documents` row pointing at it
 * (e.g. a prior partial failure elsewhere in the pipeline), which is the
 * whole point of doing a real list()+remove() sweep here instead of just
 * trusting the DB rows that are about to cascade-delete anyway.
 */
async function listProjectStorageObjectPaths(supabase: SupabaseClient, projectId: string): Promise<string[]> {
  const bucket = supabase.storage.from("documents");

  const { data: topLevel, error: topError } = await bucket.list(projectId, { limit: STORAGE_LIST_PAGE_SIZE });
  if (topError) {
    throw new Error(`listProjectStorageObjectPaths: failed to list "${projectId}/": ${topError.message}`);
  }

  const paths: string[] = [];
  for (const entry of (topLevel ?? []) as StorageEntry[]) {
    if (entry.id !== null) {
      // A real object directly under "<projectId>/" -- not the normal
      // "<projectId>/<documentId>/<suffix>" shape this app ever writes,
      // but handled defensively rather than silently skipped.
      paths.push(`${projectId}/${entry.name}`);
      continue;
    }
    // entry.id === null is Storage's way of representing a pseudo-folder
    // (here, one per document id) -- descend one level to find its actual
    // objects.
    const subPath = `${projectId}/${entry.name}`;
    const { data: children, error: childError } = await bucket.list(subPath, { limit: STORAGE_LIST_PAGE_SIZE });
    if (childError) {
      throw new Error(`listProjectStorageObjectPaths: failed to list "${subPath}/": ${childError.message}`);
    }
    for (const child of (children ?? []) as StorageEntry[]) {
      if (child.id !== null) {
        paths.push(`${subPath}/${child.name}`);
      }
      // A further-nested pseudo-folder here would mean a THIRD path
      // segment, which nothing in this codebase's Storage-path convention
      // (documents_storage_path_prefixed_with_project_id's comment,
      // lib/sources/pipeline.ts's uploadObject()) ever writes -- not
      // recursed into further, deliberately, to keep this bounded.
    }
  }
  return paths;
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  // Shape-check before touching the DB -- see the GET handler above.
  if (!isUuidShape(projectId)) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const owned = await verifyProjectOwnership(authClient, projectId);
  if (!owned) return Response.json({ error: "not_found" }, { status: 404 });

  const supabase = getServiceRoleClient();

  // Storage cleanup happens before the DB delete, and the DB delete is
  // skipped entirely if this fails -- the opposite order from the
  // single-document delete route's "DB delete first, Storage cleanup
  // best-effort after" (see that route's own comment). The difference:
  // once a project row is gone, documents/document_chunks cascade away
  // with it, so there is no longer any row anywhere in this app that
  // remembers what Storage objects used to belong to it -- a failed
  // cleanup after that point would orphan those objects permanently, with
  // nothing left to rediscover and retry removing them. Keeping the
  // project row alive on a cleanup failure means the ownership check above
  // still passes on a retried DELETE, making this naturally retryable
  // instead of a silent permanent leak.
  let paths: string[];
  try {
    paths = await listProjectStorageObjectPaths(supabase, projectId);
  } catch (err) {
    console.error(`DELETE /api/projects/${projectId}: failed to list Storage objects:`, err);
    return Response.json(
      { error: "storage_cleanup_failed", message: "Не удалось очистить хранилище проекта. Попробуйте ещё раз." },
      { status: 500 }
    );
  }

  if (paths.length > 0) {
    const { error: removeError } = await supabase.storage.from("documents").remove(paths);
    if (removeError) {
      console.error(`DELETE /api/projects/${projectId}: failed to remove ${paths.length} Storage object(s):`, removeError);
      return Response.json(
        { error: "storage_cleanup_failed", message: "Не удалось очистить хранилище проекта. Попробуйте ещё раз." },
        { status: 500 }
      );
    }
  }

  // Same zero-rows-affected race guard as the single-document delete route
  // (PostgREST returns `data: []`, `error: null` for a DELETE matching
  // nothing, not an error status): two concurrent DELETEs for the same
  // project both pass the ownership check above before either reaches this
  // statement, so `.select("id")` is what lets the loser tell "matched
  // nothing" apart from "matched and deleted one row".
  const { data: deletedRows, error: deleteError } = await supabase.from("projects").delete().eq("id", projectId).select("id");
  if (deleteError) {
    console.error(`DELETE /api/projects/${projectId}: failed to delete project row:`, deleteError);
    return Response.json({ error: "internal_error", message: "Не удалось удалить проект." }, { status: 500 });
  }
  if (!deletedRows || deletedRows.length === 0) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  return Response.json({ projectId, status: "deleted" }, { status: 200 });
}
