// app/api/sources/url/route.ts
//
// Public URL source. Thin HTTP adapter -- auth -> project-ownership check
// -> lib/sources/url.ts (SSRF-guarded fetch + content extraction, via
// lib/sources/net/safe-fetch.ts) -> lib/sources/pipeline.ts (Storage +
// ingest, upserted by (projectId, sourceType, sourceRef) so re-submitting
// the same link into the same project updates the existing document).
//
// Request contract:
//   POST /api/sources/url
//   body: { projectId: string; url: string }
//   -> 401 { error: "unauthorized" }
//   -> 400 { error: "invalid_request", details }
//   -> 404 { error: "not_found" } -- projectId doesn't exist or doesn't belong to the signed-in user
//   -> 429 { error: "rate_limited", message, retryAfterMs } -- Retry-After header set, in seconds
//   -> 400/403/504/502 { error: <SourceError.kind>, message } -- see
//      lib/sources/http-error.ts (blocked scheme/private IP, timeout, ...)
//   -> 422 { error: "no_credentials", message } if this project has no
//      active AI provider configured yet (or its owner's stored
//      credential(s) are missing) -- see lib/ai/index.ts's getAIProviders()
//      and lib/sources/http-error.ts's sourceErrorResponse(), same contract
//      as app/api/chat/route.ts's 422. Deliberately not logged via
//      console.error -- expected per-project state, not a server fault.
//   -> 200/201 { documentId, chunkCount, status: "ready" }

import "server-only";
import { z } from "zod";
import { getServiceRoleClient } from "@/lib/supabase/service-client";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient, verifyProjectOwnership } from "@/lib/supabase/server-client";
import { importUrlDocument } from "@/lib/sources/url";
import { upsertDocumentFromSource } from "@/lib/sources/pipeline";
import { sourceErrorResponse, sourceIngestRateLimitedResponse } from "@/lib/sources/http-error";
import { checkSourceIngestRateLimit } from "@/lib/rate-limit/source-ingest-rate-limiter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BodySchema = z.object({ projectId: z.string().uuid(), url: z.string().min(1).max(2048) });

export async function POST(request: Request): Promise<Response> {
  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

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
  const { projectId, url } = parsed.data;

  const owned = await verifyProjectOwnership(authClient, projectId);
  if (!owned) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  // Rate limit check happens after parsing/ownership (both cheap) but
  // BEFORE any network access (importUrlDocument -> safeFetch) or
  // AI-provider work -- CLAUDE.md rule 4. See
  // lib/rate-limit/source-ingest-rate-limiter.ts's module comment. Keyed
  // by projectId now, not userId.
  const rateLimit = checkSourceIngestRateLimit(projectId);
  if (!rateLimit.allowed) {
    return sourceIngestRateLimitedResponse(rateLimit);
  }

  const supabase = getServiceRoleClient();
  try {
    // All SSRF validation happens inside importUrlDocument -> safeFetch --
    // this route never touches the network itself.
    const normalized = await importUrlDocument(url);
    const result = await upsertDocumentFromSource(supabase, {
      projectId,
      ownerUserId: user.id,
      title: normalized.title,
      sourceType: "url",
      sourceRef: normalized.sourceRef as string, // url.ts always sets sourceRef (the final URL) -- never null
      text: normalized.text,
      object: { suffix: "content.txt", content: normalized.text, contentType: "text/plain; charset=utf-8" },
    });
    return Response.json(
      { documentId: result.documentId, chunkCount: result.chunkCount, status: "ready" },
      { status: result.created ? 201 : 200 }
    );
  } catch (err) {
    return sourceErrorResponse(err);
  }
}
