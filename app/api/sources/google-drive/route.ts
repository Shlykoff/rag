// app/api/sources/google-drive/route.ts
//
// Google Drive folder sync: lists files directly inside the given folder
// id (no recursion into subfolders -- see lib/sources/google-drive.ts and
// README "Google Drive") and imports/re-syncs each supported file as its
// own `documents` row, keyed by (user_id, source_type='google_drive',
// source_ref=file id) so calling this endpoint again for the same folder
// updates existing documents instead of duplicating them -- this endpoint
// doubles as both the initial import AND the folder-level "Refresh" (pick
// up new/changed files); refreshing a single already-imported file is
// what the generic app/api/sources/[documentId]/refresh endpoint is for.
//
// Request contract:
//   POST /api/sources/google-drive
//   body: { folderId: string }
//   -> 401 { error: "unauthorized" }
//   -> 429 { error: "rate_limited", message, retryAfterMs } -- Retry-After header set, in seconds
//   -> 400 { error: "invalid_request", details }
//   -> 400/401/403/422/502 { error: <SourceError.kind>, message } -- see
//      lib/sources/http-error.ts (whole-folder failures: not shared,
//      empty, bad credential, ...)
//   -> 200 { imported: [{ fileId, documentId, status }], skipped: [...] }
//      -- a per-file ingest failure inside an otherwise-successful sync is
//      reported as status: "error" for that file, not a whole-request
//      failure (see the loop below).

import "server-only";
import { z } from "zod";
import { getServiceRoleClient } from "@/lib/supabase/service-client";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";
import { syncGoogleDriveFolder } from "@/lib/sources/google-drive";
import { upsertDocumentFromSource } from "@/lib/sources/pipeline";
import { sourceErrorResponse, sourceIngestRateLimitedResponse } from "@/lib/sources/http-error";
import { safeErrorForLog } from "@/lib/sources/errors";
import { checkSourceIngestRateLimit } from "@/lib/rate-limit/source-ingest-rate-limiter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BodySchema = z.object({ folderId: z.string().min(1).max(200) });

export async function POST(request: Request): Promise<Response> {
  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  // Rate limit check happens BEFORE listing/downloading anything from
  // Drive or calling any AI-provider work -- CLAUDE.md rule 4. A single
  // call here can still fan out into many embeddings calls (one per file
  // in the folder) -- this bounds how often that fan-out can be
  // triggered, not the fan-out itself (which is bounded by folder
  // contents, a separate concern). See
  // lib/rate-limit/source-ingest-rate-limiter.ts's module comment.
  const rateLimit = checkSourceIngestRateLimit(user.id);
  if (!rateLimit.allowed) {
    return sourceIngestRateLimitedResponse(rateLimit);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: "invalid_request", details: "Body must be valid JSON." }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: "invalid_request", details: parsed.error.flatten() }, { status: 400 });
  }

  const supabase = getServiceRoleClient();
  try {
    const { imported, skipped } = await syncGoogleDriveFolder(supabase, user.id, parsed.data.folderId);

    const results: { fileId: string; documentId: string | null; status: "ready" | "error" }[] = [];
    for (const file of imported) {
      const fileId = file.sourceRef as string; // google-drive.ts always sets sourceRef (the Drive file id) -- never null
      try {
        const result = await upsertDocumentFromSource(supabase, {
          userId: user.id,
          title: file.title,
          sourceType: "google_drive",
          sourceRef: fileId,
          text: file.text,
          object: { suffix: "content.txt", content: file.text, contentType: "text/plain; charset=utf-8" },
        });
        results.push({ fileId, documentId: result.documentId, status: "ready" });
      } catch (err) {
        // One file's ingest failure (e.g. a transient embeddings API
        // error) must not undo/abort the rest of the folder sync -- report
        // it in the response alongside the successes rather than throwing.
        // Logged via safeErrorForLog(), not the raw `err` -- see that
        // function's doc comment (lib/sources/errors.ts) for why a raw
        // Google Drive error can carry a live OAuth Authorization header.
        console.error(`google-drive sync: failed to ingest file ${fileId} (${file.title}):`, safeErrorForLog(err));
        results.push({ fileId, documentId: null, status: "error" });
      }
    }

    return Response.json({ imported: results, skipped }, { status: 200 });
  } catch (err) {
    return sourceErrorResponse(err);
  }
}
