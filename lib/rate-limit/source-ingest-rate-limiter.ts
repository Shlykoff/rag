// lib/rate-limit/source-ingest-rate-limiter.ts
//
// Per-PROJECT request-rate limiting (projects architecture pivot --
// documents are project-scoped now, see the documents migration) for the
// source-ingestion endpoints
// (app/api/sources/upload|notion|url|google-drive|[documentId]/refresh).
// CLAUDE.md rule 4 ("проверка лимита запросов и стоимости -- на сервере,
// до вызова AI-провайдера, не только в UI") applies here exactly as much
// as it does to /api/chat: every one of those routes ends up calling
// ingestDocumentWithDefaultProviders() (a real embeddings-provider call)
// for every submission -- nothing previously stopped a caller from
// hammering e.g. POST /api/sources/url with tiny pages in a tight loop,
// each one a real, billed embeddings call, unbounded by request rate (only
// by per-document chunk count, which does nothing to limit how often a
// small document can be submitted).
//
// Deliberately NOT backed by `usage_events` (unlike
// lib/rate-limit/rate-limiter.ts's chat limiter): `usage_events.event_type`
// is a fixed Postgres enum -- currently `'chat_request' |
// 'embedding_request'`, see
// supabase/migrations/20260819052357_create_usage_events.sql -- with no
// value for "source ingestion request". Two options were considered and
// rejected in favor of this in-memory limiter:
//
//   1. Add a new enum value (e.g. `'source_ingest_request'`) and have
//      ingestion write a row for it. That's a real schema migration
//      (`ALTER TYPE ... ADD VALUE` + a new INSERT call site) -- this
//      module's owner (document-sources-specialist) does not change the
//      DB schema unilaterally per CLAUDE.md's division of responsibility;
//      that's an explicit ask for db-architect if/when this needs to be
//      DB-persisted (e.g. for multi-instance correctness -- see below).
//   2. Reuse the existing `'embedding_request'` enum value as-is (no
//      migration needed). Rejected as actively WRONG, not just imprecise:
//      lib/chat/handle-chat-request.ts already writes an
//      `embedding_request` row for every chat message's *query*
//      embedding. Counting source-ingestion attempts against that same
//      bucket would mean a user's chat activity eats into their
//      source-ingestion allowance and vice versa -- two unrelated limits
//      silently sharing one counter, which is a worse bug than having no
//      limiter at all (confusing 429s with no correlation to what the user
//      is actually doing).
//
// A simple in-memory sliding window, scoped to exactly this purpose, sidesteps
// both problems without touching the DB schema. Same explicit tradeoff as
// the chat rate limiter's own known gap (see that module's header and
// README "Rate limiting"): this is per-Node-process state, so a deployment
// with multiple warm serverless instances does not share counts across
// them. Documented, not silently gapped -- see README.

import "server-only";

export interface SourceIngestRateLimitConfig {
  /** Max /api/sources/* requests allowed within windowMs, per project. */
  maxRequests: number;
  windowMs: number;
}

/**
 * Looser than the chat limit (10/min) on purpose: a single legitimate
 * "add a few sources" session can plausibly submit several
 * URLs/files/Drive-folder-refreshes in quick succession, and each is a
 * single, comparatively small embeddings call (bounded by that one
 * document's chunk count) rather than an open-ended conversation. 20/min
 * still caps sustained hammering at a small, fixed multiple of realistic
 * interactive use.
 */
export const DEFAULT_SOURCE_INGEST_RATE_LIMIT: SourceIngestRateLimitConfig = {
  maxRequests: 20,
  windowMs: 60_000, // 1 minute
};

export interface SourceIngestRateLimitResult {
  allowed: boolean;
  /** How many requests this project has made in the current window, INCLUDING this one when allowed. */
  currentCount: number;
  limit: number;
  /** Milliseconds until the oldest request in the window ages out -- a reasonable "try again in" hint. Only meaningful when allowed === false. */
  retryAfterMs: number;
}

const requestTimestamps = new Map<string, number[]>();

/** Test-only escape hatch: requestTimestamps is module-level state that would otherwise leak between test cases run in the same process. Not meant to be reached for outside lib/rate-limit/__tests__. */
export function __resetSourceIngestRateLimitForTests(): void {
  requestTimestamps.clear();
}

/**
 * Checks AND records one request attempt for `projectId`, atomically.
 * Unlike the chat limiter's two-step "DB count, then in-memory
 * reservation" design (needed there because the DB row for a chat request
 * is only written seconds later, after the full response streams), there
 * is no `await` anywhere in this function at all -- the count IS the
 * state, kept entirely in memory, updated synchronously. Node's
 * single-threaded event loop means no other call for the same project can
 * interleave inside a fully synchronous function, so this can't be raced
 * by a parallel burst the way a naive "check, then separately record"
 * split could be.
 *
 * Call this once, immediately after authenticating the caller and
 * verifying project ownership, BEFORE any adapter/AI-provider work starts,
 * in every app/api/sources/* route (see lib/sources/http-error.ts's
 * `sourceIngestRateLimitedResponse` for the matching HTTP response
 * helper).
 */
export function checkSourceIngestRateLimit(
  projectId: string,
  config: SourceIngestRateLimitConfig = DEFAULT_SOURCE_INGEST_RATE_LIMIT
): SourceIngestRateLimitResult {
  const now = Date.now();
  const cutoff = now - config.windowMs;
  const existing = requestTimestamps.get(projectId) ?? [];
  const fresh = existing.filter((ts) => ts > cutoff);

  if (fresh.length >= config.maxRequests) {
    // Still write back the purged (but not incremented) list -- keeps the
    // map from accumulating stale entries for a project that keeps getting
    // rejected without ever succeeding.
    if (fresh.length > 0) requestTimestamps.set(projectId, fresh);
    else requestTimestamps.delete(projectId);
    const oldest = fresh[0];
    return {
      allowed: false,
      currentCount: fresh.length,
      limit: config.maxRequests,
      retryAfterMs: Math.max(0, oldest + config.windowMs - now),
    };
  }

  fresh.push(now);
  requestTimestamps.set(projectId, fresh);
  return { allowed: true, currentCount: fresh.length, limit: config.maxRequests, retryAfterMs: 0 };
}
