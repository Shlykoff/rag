// app/api/sources/shared.ts
//
// Small helper shared by app/api/sources/[documentId]/route.ts (DELETE) and
// its .../refresh/route.ts sibling (POST), which both used to duplicate the
// exact same "load a document row, then verify its project's ownership"
// sequence -- including the identical 404-for-both-"missing"-and-"someone
// else's" posture (see verifyProjectOwnership's own comment for why that
// matters). NOT a `lib/` module -- route-local, colocated under
// app/api/sources/, the same convention app/api/projects/shared.ts already
// established for this exact kind of two-callers-only helper.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { verifyProjectOwnership } from "@/lib/supabase/server-client";

export type LoadOwnedDocumentResult<T> =
  | { ok: true; doc: T }
  | { ok: false; status: 404; body: { error: "not_found" } }
  | { ok: false; status: 500; body: { error: "internal_error"; message: string } };

/**
 * Loads one `documents` row by id (via the service-role client, selecting
 * exactly `selectColumns`) and verifies its `project_id` belongs to the
 * current session (via the RLS-scoped `authClient`) -- the two-step check
 * every route that operates on a single document needs before doing
 * anything else with it. Returns a discriminated result instead of writing
 * the Response directly, so each caller keeps full control over its own
 * success path/logging while sharing this exact lookup+ownership sequence.
 *
 * Identical 404 for "no such document" and "exists, but its project
 * belongs to someone else" -- an authenticated-but-unauthorized caller must
 * not be able to distinguish the two (same posture both call sites already
 * had independently before this was extracted).
 */
export async function loadOwnedDocument<T extends { project_id: string }>(
  serviceClient: SupabaseClient,
  authClient: SupabaseClient,
  documentId: string,
  selectColumns: string
): Promise<LoadOwnedDocumentResult<T>> {
  const { data: doc, error } = await serviceClient
    .from("documents")
    .select(selectColumns)
    .eq("id", documentId)
    .maybeSingle<T>();
  if (error) {
    console.error(`loadOwnedDocument: failed to load document ${documentId}:`, error);
    return { ok: false, status: 500, body: { error: "internal_error", message: "Не удалось загрузить документ." } };
  }
  if (!doc) {
    return { ok: false, status: 404, body: { error: "not_found" } };
  }

  const owned = await verifyProjectOwnership(authClient, doc.project_id);
  if (!owned) {
    return { ok: false, status: 404, body: { error: "not_found" } };
  }

  return { ok: true, doc };
}
