// lib/http/rate-limited-response.ts
//
// Shared `429 { error: "rate_limited", message, retryAfterMs }` + a
// `Retry-After` header (in seconds) response shape -- independently
// reimplemented 3-4 times across app/api/chat/route.ts (inline),
// app/api/profile/ai-providers/route.ts's own private `rateLimitedResponse`,
// app/api/projects/[projectId]/channels/telegram/route.ts's own private
// `rateLimitedResponse`, and lib/sources/http-error.ts's
// `sourceIngestRateLimitedResponse` -- all four wanting the exact same
// wire shape for whichever in-memory/DB-backed rate limiter rejected the
// request. The one thing that legitimately differs between call sites is
// the Russian user-facing message (worded per-resource: "запросов к
// настройкам AI-провайдера" vs. "запросов на добавление источников", ...),
// so that's the one required parameter.

export function rateLimitedResponse(message: string, retryAfterMs: number): Response {
  return Response.json(
    { error: "rate_limited", message, retryAfterMs },
    { status: 429, headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) } }
  );
}
