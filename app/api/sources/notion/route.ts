// app/api/sources/notion/route.ts
//
// Notion page/database import. Thin HTTP adapter -- auth ->
// lib/sources/notion.ts (fetch + flatten to text, using the caller's
// encrypted Internal Integration Secret) -> lib/sources/pipeline.ts
// (Storage + ingest, upserted by Notion id so re-submitting the same page
// updates the existing document rather than duplicating it).
//
// Request contract:
//   POST /api/sources/notion
//   body: { pageUrl: string }  -- a notion.so page/database URL, or a bare id
//   -> 401 { error: "unauthorized" }
//   -> 429 { error: "rate_limited", message, retryAfterMs } -- Retry-After header set, in seconds
//   -> 400 { error: "invalid_request", details }
//   -> 400/401/403/502 { error: <SourceError.kind>, message } -- see
//      lib/sources/http-error.ts ("not_shared" is the common case: page
//      exists but isn't shared with the integration)
//   -> 200/201 { documentId, chunkCount, status: "ready" }

import "server-only";
import { z } from "zod";
import { getServiceRoleClient } from "@/lib/supabase/service-client";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";
import { importNotionDocument } from "@/lib/sources/notion";
import { upsertDocumentFromSource } from "@/lib/sources/pipeline";
import { sourceErrorResponse, sourceIngestRateLimitedResponse } from "@/lib/sources/http-error";
import { checkSourceIngestRateLimit } from "@/lib/rate-limit/source-ingest-rate-limiter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BodySchema = z.object({ pageUrl: z.string().min(1).max(2048) });

export async function POST(request: Request): Promise<Response> {
  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  // Rate limit check happens BEFORE any adapter/AI-provider work --
  // CLAUDE.md rule 4. See lib/rate-limit/source-ingest-rate-limiter.ts's
  // module comment.
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
    const normalized = await importNotionDocument(supabase, user.id, parsed.data.pageUrl);
    const result = await upsertDocumentFromSource(supabase, {
      userId: user.id,
      title: normalized.title,
      sourceType: "notion",
      sourceRef: normalized.sourceRef as string, // notion.ts always sets sourceRef (the normalized page/database id) -- never null
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
