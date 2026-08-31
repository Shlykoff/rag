// lib/sources/http-error.ts
//
// Shared SourceError -> HTTP Response mapping for every route under
// app/api/sources/ -- keeps the status-code choices (401 for missing/bad
// credentials, 403 for "not shared", 400 for bad input, 502 for an
// unclassified upstream failure, ...) consistent across manual-upload/
// notion/url/google-drive/refresh instead of each route re-deriving them.

import "server-only";
import { SourceError } from "./errors";
import { AIProviderError } from "../ai/errors";
import type { SourceIngestRateLimitResult } from "../rate-limit/source-ingest-rate-limiter";
import { rateLimitedResponse } from "../http/rate-limited-response";

const STATUS_BY_KIND: Record<SourceError["kind"], number> = {
  invalid_input: 400,
  unsupported_file_type: 400,
  too_large: 400,
  empty_content: 422,
  ssrf_blocked: 400,
  timeout: 504,
  unauthorized: 401,
  not_shared: 403,
  not_found: 404,
  upstream_error: 502,
  unknown: 502,
};

/**
 * Every app/api/sources/* route eventually calls
 * lib/ingestion/ingest.ts's ingestDocumentWithDefaultProviders() (directly,
 * or via lib/sources/pipeline.ts's create/refresh/upsertDocumentFromSource)
 * to embed the document it just fetched/parsed -- which throws
 * AIProviderError{kind:"no_credentials"} (never a SourceError; see
 * lib/ai/index.ts's getAIProviders()) when the signed-in user has no active
 * AI provider configured yet, or their active provider's stored
 * credential(s) are missing. That's a per-user "hasn't finished setup" state,
 * not a source-adapter failure or a server fault, so it gets its own branch
 * here -- same 422 { error: "no_credentials", message } contract and the
 * same "don't console.error this" treatment as app/api/chat/route.ts (see
 * that route's header comment for the full rationale: every not-yet-
 * configured user's first upload would otherwise spam logs with "errors"
 * that are really just "this user hasn't visited /profile yet"). Handled
 * centrally here, once, rather than duplicated in every route's catch block,
 * since all five routes (upload/notion/url/google-drive/refresh) already
 * funnel their catch through this same function.
 */
export function sourceErrorResponse(err: unknown): Response {
  if (err instanceof AIProviderError && err.kind === "no_credentials") {
    return Response.json({ error: "no_credentials", message: err.userMessage }, { status: 422 });
  }
  if (err instanceof SourceError) {
    return Response.json({ error: err.kind, message: err.userMessage }, { status: STATUS_BY_KIND[err.kind] });
  }
  // Neither a SourceError nor a no-credentials AIProviderError -- an
  // unexpected failure (DB write error, a non-"no_credentials"
  // AIProviderError such as a real embeddings-API outage, a bug, etc.).
  // Never leak err.message to the client; log it server-side instead.
  console.error("app/api/sources: unhandled error during source ingestion:", err);
  return Response.json({ error: "internal_error", message: "Произошла непредвиденная ошибка." }, { status: 500 });
}

/**
 * Standard 429 response for a rejected `checkSourceIngestRateLimit()`
 * result -- shared across every app/api/sources/* route so the response
 * shape (`{ error: "rate_limited", message, retryAfterMs }` + a
 * `Retry-After` header, in seconds) matches app/api/chat/route.ts's own
 * rate-limit response exactly, giving frontend code one consistent
 * contract to handle regardless of which endpoint returned it.
 */
export function sourceIngestRateLimitedResponse(rateLimit: Pick<SourceIngestRateLimitResult, "retryAfterMs">): Response {
  return rateLimitedResponse(
    "Слишком много запросов на добавление источников. Попробуйте через несколько секунд.",
    rateLimit.retryAfterMs
  );
}
