// app/api/sources/[documentId]/route.ts
//
// Delete one document from the RAG system (its `document_chunks` and their
// embeddings go with it, via the `on delete cascade` FK -- see
// supabase/migrations/20260819052352_create_document_chunks_table.sql --
// this route never touches document_chunks directly). Lives in its own
// route.ts (rather than as another export in
// [documentId]/refresh/route.ts) because it's a different URL segment in
// the Next.js App Router: "/api/sources/{documentId}" vs.
// "/api/sources/{documentId}/refresh" are two distinct route trees, each
// gets its own route.ts.
//
// PROJECTS PIVOT: `documents` no longer carries a `user_id` column (see
// the documents migration) -- ownership is derived one hop through its
// parent project, so this route now fetches the document's `project_id`
// first and then verifies that project's ownership via the RLS-scoped
// session client (lib/supabase/server-client.ts's
// verifyProjectOwnership()), instead of the old single `.eq("user_id",
// userId)` filter baked straight into the SELECT/DELETE.
//
// Request contract:
//   DELETE /api/sources/{documentId}
//   -> 401 { error: "unauthorized" }
//   -> 404 { error: "not_found" } -- no such document, its project belongs
//      to another user (identical response for both, same posture as
//      refresh/route.ts -- don't let an authenticated-but-unauthorized
//      caller distinguish the two), OR it was already deleted by a
//      concurrent request that reached the DB delete first (see the
//      `.select("id")` comment below) -- so under two truly simultaneous
//      DELETEs for the same document, exactly one caller gets 200 and the
//      other gets 404, never 200+200.
//   -> 200 { documentId, status: "deleted" }
//
// No rate limiting here (unlike upload/notion/url/google-drive/refresh):
// this route never calls an AI provider or an external source, so there's
// no per-request cost to bound (CLAUDE.md rule 4 / the task's own note).

import "server-only";
import { getServiceRoleClient } from "@/lib/supabase/service-client";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient, verifyProjectOwnership } from "@/lib/supabase/server-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface DocumentRow {
  id: string;
  project_id: string;
  storage_path: string | null;
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ documentId: string }> }
): Promise<Response> {
  const { documentId } = await params;

  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const supabase = getServiceRoleClient();
  const { data: doc, error } = await supabase
    .from("documents")
    .select("id, project_id, storage_path")
    .eq("id", documentId)
    .maybeSingle<DocumentRow>();
  if (error) {
    console.error(`delete route: failed to load document ${documentId}:`, error);
    return Response.json({ error: "internal_error", message: "Не удалось загрузить документ." }, { status: 500 });
  }
  if (!doc) {
    // Same "identical response for missing vs. someone else's document" as
    // refresh/route.ts -- see that file's comment for the reasoning.
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const owned = await verifyProjectOwnership(authClient, doc.project_id);
  if (!owned) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  // Delete the `documents` row (and, via cascade, its document_chunks)
  // BEFORE touching Storage -- deliberately, not just "in whatever order
  // is convenient":
  //   - If the DB delete succeeds but the Storage delete below then fails,
  //     the result is an orphaned object in the `documents` bucket. That's
  //     harmless: nothing references it anymore (the row is gone), it
  //     costs a few KB/MB of storage, and it doesn't affect retrieval,
  //     chunking, or any other document -- an acceptable, self-contained
  //     leftover.
  //   - If it ran the other way around (Storage delete first) and the DB
  //     delete then failed, the user would be left with a `documents` row
  //     that still looks "live" -- it'd still show up in listings and
  //     still be a candidate for retrieval/chat context -- but its
  //     storage_path now points at nothing, so re-chunking or a manual
  //     "Refresh" on it would break. That's a strictly worse failure mode
  //     than a harmless orphaned Storage object.
  // In short: DB delete is the operation that actually matters for "is
  // this document still in the RAG system" (chat/retrieval only ever read
  // from documents/document_chunks, never from Storage directly), so it
  // goes first and its success is what the 200 response below promises.
  // `.select("id")` here is load-bearing, not decoration: without it, a
  // `DELETE ... WHERE id = X` that matches ZERO rows still comes back with
  // `error: null` from PostgREST -- a delete matching nothing is not,
  // itself, an error. That's exactly what happens when two DELETE requests
  // for the same document race each other (e.g. a double-click, or two
  // tabs): the ownership check above already passed for both by the time
  // either reaches this DELETE, so without `.select()` both would fall
  // through to the 200 below even though only one of them actually removed
  // a row -- confirmed empirically against a real local Postgres with two
  // concurrent `Promise.all` deletes: the "loser" gets back `data: []` (an
  // empty array, NOT null) with `error: null`, not a 404/409/anything
  // distinguishable without checking `data.length`. See
  // __tests__/route.integration.test.ts's "parallel DELETE" case, which
  // reproduces this against real Postgres. (Ownership is already verified
  // above via the project, so this DELETE only needs to target `id` --
  // unlike the pre-pivot version, it can no longer also filter on a
  // `user_id` column that doesn't exist on `documents` anymore.)
  const { data: deletedRows, error: deleteError } = await supabase
    .from("documents")
    .delete()
    .eq("id", documentId)
    .select("id");
  if (deleteError) {
    console.error(`delete route: failed to delete document ${documentId}:`, deleteError);
    return Response.json({ error: "internal_error", message: "Не удалось удалить документ." }, { status: 500 });
  }
  if (!deletedRows || deletedRows.length === 0) {
    // Lost the race: some other request (most likely another DELETE for
    // this same document) already removed the row between our ownership
    // check above and this statement. From this request's point of view
    // the document is gone -- same as the "doesn't exist" case above, so
    // same response, and deliberately skip the Storage-remove below (it
    // already ran, or is about to run, as part of whichever request won).
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  if (doc.storage_path) {
    const { error: storageError } = await supabase.storage.from("documents").remove([doc.storage_path]);
    if (storageError) {
      // Best-effort cleanup only -- the document is already gone from the
      // RAG system (the DB delete above is what matters; see the comment
      // there), so a Storage-delete failure here must not surface as an
      // error to the caller. Logged so an orphaned object can be found
      // and cleaned up out-of-band if this ever fires.
      console.error(`delete route: failed to remove storage object ${doc.storage_path} for document ${documentId}:`, storageError);
    }
  }

  return Response.json({ documentId, status: "deleted" }, { status: 200 });
}
