// app/api/sources/upload/route.ts
//
// Manual file upload: PDF/markdown/txt via multipart/form-data. Thin HTTP
// adapter -- auth -> lib/sources/manual-upload.ts (validate + extract
// text) -> lib/sources/pipeline.ts (Storage + ingest). See those modules
// for the actual logic.
//
// Request contract:
//   POST /api/sources/upload
//   body: multipart/form-data, field "file"
//   -> 401 { error: "unauthorized" }
//   -> 429 { error: "rate_limited", message, retryAfterMs } -- Retry-After header set, in seconds
//   -> 400 { error: "invalid_request", details } -- missing/oversized file
//   -> 400/422/500 { error: <SourceError.kind>, message } -- see
//      lib/sources/http-error.ts (unsupported type, empty content, ...)
//   -> 422 { error: "no_credentials", message } if the signed-in user has no
//      active AI provider configured yet (or its stored credential(s) are
//      missing) -- see lib/ai/index.ts's getAIProviders() and
//      lib/sources/http-error.ts's sourceErrorResponse(), same contract as
//      app/api/chat/route.ts's 422 (nextjs-frontend's "add a provider" UI
//      reacts to this code the same way regardless of which endpoint sent
//      it). Deliberately not logged via console.error -- expected per-user
//      state, not a server fault.
//   -> 201 { documentId, chunkCount, status: "ready" }

import "server-only";
import { getServiceRoleClient } from "@/lib/supabase/service-client";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";
import { processManualUpload, MANUAL_UPLOAD_MAX_BYTES } from "@/lib/sources/manual-upload";
import { createDocumentFromSource } from "@/lib/sources/pipeline";
import { sourceErrorResponse, sourceIngestRateLimitedResponse } from "@/lib/sources/http-error";
import { checkSourceIngestRateLimit } from "@/lib/rate-limit/source-ingest-rate-limiter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // Rate limit check happens BEFORE reading the body / calling any
  // adapter or AI-provider work -- CLAUDE.md rule 4, mirroring
  // app/api/chat/route.ts's placement. See
  // lib/rate-limit/source-ingest-rate-limiter.ts's module comment for why
  // this is a separate, in-memory limiter rather than reusing the chat
  // limiter's usage_events-backed one.
  const rateLimit = checkSourceIngestRateLimit(user.id);
  if (!rateLimit.allowed) {
    return sourceIngestRateLimitedResponse(rateLimit);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: "invalid_request", details: "Expected multipart/form-data." }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "invalid_request", details: "Missing 'file' field." }, { status: 400 });
  }
  // Fast-path rejection by the browser-reported size before reading the
  // whole body into memory -- processManualUpload() below still enforces
  // the same limit against the real byte length (a client can misreport
  // `file.size`), so this is a UX/DoS-cost optimization, not the actual
  // enforcement.
  if (file.size > MANUAL_UPLOAD_MAX_BYTES) {
    return Response.json(
      { error: "invalid_request", details: `File exceeds the ${Math.round(MANUAL_UPLOAD_MAX_BYTES / (1024 * 1024))}MB limit.` },
      { status: 400 }
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const supabase = getServiceRoleClient();

  try {
    const normalized = await processManualUpload({ filename: file.name, mimeType: file.type || null, buffer });
    const result = await createDocumentFromSource(supabase, {
      userId: user.id,
      title: normalized.title,
      sourceType: "manual_upload",
      sourceRef: null,
      text: normalized.text,
      object: {
        suffix: `original.${normalized.original.extension}`,
        content: normalized.original.buffer,
        contentType: normalized.original.contentType,
      },
    });
    return Response.json({ documentId: result.documentId, chunkCount: result.chunkCount, status: "ready" }, { status: 201 });
  } catch (err) {
    return sourceErrorResponse(err);
  }
}
