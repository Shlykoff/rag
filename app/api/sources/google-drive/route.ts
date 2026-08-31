// app/api/sources/google-drive/route.ts
//
// Google Drive folder sync: lists files directly inside the given folder
// id (no recursion into subfolders -- see lib/sources/google-drive.ts and
// README "Google Drive") and imports/re-syncs each supported file as its
// own `documents` row, keyed by (projectId, source_type='google_drive',
// source_ref=file id) so calling this endpoint again for the same
// project+folder updates existing documents instead of duplicating them --
// this endpoint doubles as both the initial import AND the folder-level
// "Refresh" (pick up new/changed files); refreshing a single
// already-imported file is what the generic
// app/api/sources/[documentId]/refresh endpoint is for.
//
// Request contract:
//   POST /api/sources/google-drive
//   body: { projectId: string; folderId: string }
//   -> 401 { error: "unauthorized" }
//   -> 400 { error: "invalid_request", details }
//   -> 404 { error: "not_found" } -- projectId doesn't exist or doesn't belong to the signed-in user
//   -> 429 { error: "rate_limited", message, retryAfterMs } -- Retry-After header set, in seconds
//   -> 400/401/403/422/502 { error: <SourceError.kind>, message } -- see
//      lib/sources/http-error.ts (whole-folder failures: not shared,
//      empty, bad credential, ...)
//   -> 422 { error: "no_credentials", message } if this project has no
//      active AI provider configured yet (or its owner's stored
//      credential(s) are missing) -- see lib/ai/index.ts's
//      getAIProviders(). Unlike a per-file Drive/embeddings failure (which
//      is reported per-file in the 200 response below), this is a
//      per-PROJECT, whole-request condition -- every file would fail
//      identically -- so it short-circuits the loop and comes back as one
//      clean 422 instead of N "status: error" rows (see the loop's own
//      comment). Deliberately not logged via console.error -- expected
//      per-project state, not a server fault.
//   -> 200 { imported: [{ fileId, documentId, status }], skipped: [...] }
//      -- a per-file ingest failure inside an otherwise-successful sync is
//      reported as status: "error" for that file, not a whole-request
//      failure (see the loop below).

import "server-only";
import { z } from "zod";
import { getServiceRoleClient } from "@/lib/supabase/service-client";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient, verifyProjectOwnership } from "@/lib/supabase/server-client";
import { syncGoogleDriveFolder } from "@/lib/sources/google-drive";
import { upsertDocumentFromSource } from "@/lib/sources/pipeline";
import { sourceErrorResponse, sourceIngestRateLimitedResponse } from "@/lib/sources/http-error";
import { safeErrorForLog } from "@/lib/sources/errors";
import { AIProviderError } from "@/lib/ai/errors";
import { checkSourceIngestRateLimit } from "@/lib/rate-limit/source-ingest-rate-limiter";
import { uuidShapeSchema } from "@/lib/validation/uuid";
import { parseJsonBody } from "@/lib/http/parse-json-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// `uuidShapeSchema`, not `z.string().uuid()` -- see lib/validation/uuid.ts's
// header: Zod's built-in validator is RFC-4122-version-strict and rejects
// the seeded demo project's sentinel id, a real Postgres `uuid` value.
const BodySchema = z.object({ projectId: uuidShapeSchema, folderId: z.string().min(1).max(200) });

// Files are ingested with bounded concurrency, not strictly one-at-a-time
// -- each file's upsertDocumentFromSource() call is an independent chunk+
// embed+store pipeline (lib/ingestion/ingest.ts) with no data dependency on
// any other file in the folder, so a large folder no longer waits on every
// file sequentially. Capped (not a fully unbounded Promise.all across the
// whole folder) for the same reason lib/ai/embed-batch.ts caps its own
// per-document batch concurrency: a folder can realistically contain many
// files, and firing all of their embeddings calls at once risks tripping
// the embeddings vendor's own per-account rate/concurrency limits.
const INGEST_CONCURRENCY = 4;

export async function POST(request: Request): Promise<Response> {
  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const parsed = await parseJsonBody(request, BodySchema);
  if ("errorResponse" in parsed) return parsed.errorResponse;
  const { projectId, folderId } = parsed.data;

  const owned = await verifyProjectOwnership(authClient, projectId);
  if (!owned) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  // Rate limit check happens after parsing/ownership (both cheap) but
  // BEFORE listing/downloading anything from Drive or calling any
  // AI-provider work -- CLAUDE.md rule 4. A single call here can still fan
  // out into many embeddings calls (one per file in the folder) -- this
  // bounds how often that fan-out can be triggered, not the fan-out itself
  // (which is bounded by folder contents, a separate concern). Keyed by
  // projectId now, not userId. See
  // lib/rate-limit/source-ingest-rate-limiter.ts's module comment.
  const rateLimit = checkSourceIngestRateLimit(projectId);
  if (!rateLimit.allowed) {
    return sourceIngestRateLimitedResponse(rateLimit);
  }

  const supabase = getServiceRoleClient();
  // Captured by the `worker()` closure below -- assigned to its own const
  // so TypeScript's null-narrowing of `user` (from the `if (!user) return`
  // guard above) doesn't need to survive into a nested function
  // declaration, which it can't reliably do across an intervening `await`.
  const ownerUserId = user.id;
  try {
    // The Drive credential lookup itself stays account-level (ownerUserId,
    // not projectId) -- source credentials are still per-account, see
    // lib/sources/credentials.ts's own header.
    const { imported, skipped } = await syncGoogleDriveFolder(supabase, ownerUserId, folderId);

    const results: { fileId: string; documentId: string | null; status: "ready" | "error" }[] = [];
    // Set the moment ANY worker sees a whole-project no_credentials failure
    // -- every other worker checks this before picking up its next file, so
    // once detected, no further NEW ingests start (workers already in
    // flight when it's set are not aborted, since AIProviderError -- unlike
    // a bad network call -- has no cancelable in-flight request to abort;
    // they're simply allowed to finish, and their errors are ignored below
    // since noCredentialsError is already set).
    let noCredentialsError: AIProviderError | null = null;

    let nextIndex = 0;
    async function worker(): Promise<void> {
      while (nextIndex < imported.length) {
        if (noCredentialsError) return;
        const file = imported[nextIndex++];
        const fileId = file.sourceRef as string; // google-drive.ts always sets sourceRef (the Drive file id) -- never null
        try {
          const result = await upsertDocumentFromSource(supabase, {
            projectId,
            ownerUserId,
            title: file.title,
            sourceType: "google_drive",
            sourceRef: fileId,
            text: file.text,
            object: { suffix: "content.txt", content: file.text, contentType: "text/plain; charset=utf-8" },
          });
          results.push({ fileId, documentId: result.documentId, status: "ready" });
        } catch (err) {
          // "No active AI provider" is a per-PROJECT state, not a per-file
          // one (see lib/ai/index.ts's getAIProviders()) -- every remaining
          // file in this folder would fail with the exact same
          // AIProviderError{kind:"no_credentials"}, so recording N identical
          // per-file "error" rows (and burning through the whole folder
          // doing it) would be both wasteful and a worse message than just
          // telling the user once to configure a provider. Recorded (not
          // thrown from inside the worker itself) so every OTHER worker
          // can see it and stop picking up new work too -- rethrown once,
          // after every worker has settled, below.
          if (err instanceof AIProviderError && err.kind === "no_credentials") {
            noCredentialsError = err;
            return;
          }
          // Any other, genuinely per-file ingest failure (e.g. a transient
          // embeddings API error, or a Drive-specific issue for just this
          // file) must not undo/abort the rest of the folder sync -- report
          // it in the response alongside the successes rather than throwing.
          // Logged via safeErrorForLog(), not the raw `err` -- see that
          // function's doc comment (lib/sources/errors.ts) for why a raw
          // Google Drive error can carry a live OAuth Authorization header.
          console.error(`google-drive sync: failed to ingest file ${fileId} (${file.title}):`, safeErrorForLog(err));
          results.push({ fileId, documentId: null, status: "error" });
        }
      }
    }

    const workerCount = Math.min(INGEST_CONCURRENCY, imported.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    if (noCredentialsError) {
      // Handled by the outer catch -> sourceErrorResponse(), which turns it
      // into the same clean 422 { error: "no_credentials" } every other
      // app/api/sources/* route returns -- see that function's comment.
      throw noCredentialsError;
    }

    return Response.json({ imported: results, skipped }, { status: 200 });
  } catch (err) {
    return sourceErrorResponse(err);
  }
}
