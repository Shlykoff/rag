// app/api/sources/url/route.ts
//
// Public URL source. Thin HTTP adapter -- auth -> lib/sources/url.ts
// (SSRF-guarded fetch + content extraction, via lib/sources/net/safe-fetch.ts)
// -> lib/sources/pipeline.ts (Storage + ingest, upserted by final URL so
// re-submitting the same link updates the existing document).
//
// Request contract:
//   POST /api/sources/url
//   body: { url: string }
//   -> 401 { error: "unauthorized" }
//   -> 429 { error: "rate_limited", message, retryAfterMs } -- Retry-After header set, in seconds
//   -> 400 { error: "invalid_request", details }
//   -> 400/403/504/502 { error: <SourceError.kind>, message } -- see
//      lib/sources/http-error.ts (blocked scheme/private IP, timeout, ...)
//   -> 422 { error: "no_credentials", message } if the signed-in user has no
//      active AI provider configured yet (or its stored credential(s) are
//      missing) -- see lib/ai/index.ts's getAIProviders() and
//      lib/sources/http-error.ts's sourceErrorResponse(), same contract as
//      app/api/chat/route.ts's 422. Deliberately not logged via
//      console.error -- expected per-user state, not a server fault.
//   -> 200/201 { documentId, chunkCount, status: "ready" }

import "server-only";
import { z } from "zod";
import { getServiceRoleClient } from "@/lib/supabase/service-client";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";
import { importUrlDocument } from "@/lib/sources/url";
import { upsertDocumentFromSource } from "@/lib/sources/pipeline";
import { sourceErrorResponse, sourceIngestRateLimitedResponse } from "@/lib/sources/http-error";
import { checkSourceIngestRateLimit } from "@/lib/rate-limit/source-ingest-rate-limiter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BodySchema = z.object({ url: z.string().min(1).max(2048) });

export async function POST(request: Request): Promise<Response> {
  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  // Rate limit check happens BEFORE any network access (importUrlDocument
  // -> safeFetch) or AI-provider work -- CLAUDE.md rule 4. See
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
    // All SSRF validation happens inside importUrlDocument -> safeFetch --
    // this route never touches the network itself.
    const normalized = await importUrlDocument(parsed.data.url);
    const result = await upsertDocumentFromSource(supabase, {
      userId: user.id,
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
