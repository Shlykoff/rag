// lib/sources/http-error.ts
//
// Shared SourceError -> HTTP Response mapping for every route under
// app/api/sources/ -- keeps the status-code choices (401 for missing/bad
// credentials, 403 for "not shared", 400 for bad input, 502 for an
// unclassified upstream failure, ...) consistent across manual-upload/
// notion/url/google-drive/refresh instead of each route re-deriving them.

import "server-only";
import { SourceError } from "./errors";
import type { SourceIngestRateLimitResult } from "../rate-limit/source-ingest-rate-limiter";

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

export function sourceErrorResponse(err: unknown): Response {
  if (err instanceof SourceError) {
    return Response.json({ error: err.kind, message: err.userMessage }, { status: STATUS_BY_KIND[err.kind] });
  }
  // Not a SourceError -- an unexpected failure (DB write error, bug, etc.).
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
  return Response.json(
    {
      error: "rate_limited",
      message: "Слишком много запросов на добавление источников. Попробуйте через несколько секунд.",
      retryAfterMs: rateLimit.retryAfterMs,
    },
    {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rateLimit.retryAfterMs / 1000)) },
    }
  );
}
