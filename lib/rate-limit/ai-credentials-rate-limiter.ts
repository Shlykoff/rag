// lib/rate-limit/ai-credentials-rate-limiter.ts
//
// Per-user request-rate limiting for the state-changing calls on
// app/api/profile/ai-providers/route.ts (POST save-a-key, DELETE
// remove-a-key, PUT set-active-provider). CLAUDE.md rule 4 ("проверка
// лимита запросов -- на сервере, до вызова AI-провайдера") doesn't apply
// here in the "billed AI call" sense this route never calls a vendor SDK
// at all -- but an unbounded write endpoint is still worth capping: each
// call does a real encrypt (lib/ai/crypto.ts) + a real DB upsert/delete,
// and there's no reason a legitimate user needs more than a handful of
// these in a minute (they're editing a handful of provider slots by hand,
// not scripting bulk writes).
//
// Deliberately mirrors lib/rate-limit/source-ingest-rate-limiter.ts's
// design almost exactly -- see that file's header for the full reasoning
// this repeats: NOT backed by `usage_events` (its event_type enum has no
// value for "credentials write", and this isn't a billed-AI-call event
// anyway, unlike chat_request/embedding_request), a simple in-memory
// sliding window instead, same documented multi-instance limitation (only
// closes the burst race within one warm Node process/serverless instance).
// Kept as its own small module (not a re-export of
// source-ingest-rate-limiter.ts's implementation) so the two limiters'
// state maps stay independent -- a user hammering POST /api/sources/url
// must not eat into their POST /api/profile/ai-providers allowance or vice
// versa, same reasoning as source-ingest-rate-limiter.ts's own "don't share
// a bucket with an unrelated action" argument.

import "server-only";

export interface AICredentialsRateLimitConfig {
  /** Max /api/profile/ai-providers write requests allowed within windowMs, per user. */
  maxRequests: number;
  windowMs: number;
}

/**
 * Tighter than the source-ingest limit (20/min): saving/removing a provider
 * key or switching the active provider is a rare, deliberate, one-at-a-time
 * action a real user takes a handful of times per session (add a key, maybe
 * fix a typo, pick an active provider) -- not something a legitimate burst
 * of interactive use would ever need double digits of in a minute.
 */
export const DEFAULT_AI_CREDENTIALS_RATE_LIMIT: AICredentialsRateLimitConfig = {
  maxRequests: 10,
  windowMs: 60_000, // 1 minute
};

export interface AICredentialsRateLimitResult {
  allowed: boolean;
  /** How many requests this user has made in the current window, INCLUDING this one when allowed. */
  currentCount: number;
  limit: number;
  /** Milliseconds until the oldest request in the window ages out -- a reasonable "try again in" hint. Only meaningful when allowed === false. */
  retryAfterMs: number;
}

const requestTimestamps = new Map<string, number[]>();

/** Test-only escape hatch: requestTimestamps is module-level state that would otherwise leak between test cases run in the same process. Not meant to be reached for outside lib/rate-limit/__tests__. */
export function __resetAICredentialsRateLimitForTests(): void {
  requestTimestamps.clear();
}

/**
 * Checks AND records one request attempt for `userId`, atomically -- same
 * "no `await` anywhere, so no burst-gap to race" shape as
 * checkSourceIngestRateLimit() (see that function's own doc comment for the
 * full explanation of why a fully synchronous check-and-record closes the
 * race a naive "check, then separately record" split would leave open).
 *
 * Call this once, immediately after authenticating the caller and BEFORE
 * any encrypt/DB-write work starts, in every state-changing handler
 * (POST/DELETE/PUT) of app/api/profile/ai-providers/route.ts.
 */
export function checkAICredentialsRateLimit(
  userId: string,
  config: AICredentialsRateLimitConfig = DEFAULT_AI_CREDENTIALS_RATE_LIMIT
): AICredentialsRateLimitResult {
  const now = Date.now();
  const cutoff = now - config.windowMs;
  const existing = requestTimestamps.get(userId) ?? [];
  const fresh = existing.filter((ts) => ts > cutoff);

  if (fresh.length >= config.maxRequests) {
    // Still write back the purged (but not incremented) list -- keeps the
    // map from accumulating stale entries for a user who keeps getting
    // rejected without ever succeeding.
    if (fresh.length > 0) requestTimestamps.set(userId, fresh);
    else requestTimestamps.delete(userId);
    const oldest = fresh[0];
    return {
      allowed: false,
      currentCount: fresh.length,
      limit: config.maxRequests,
      retryAfterMs: Math.max(0, oldest + config.windowMs - now),
    };
  }

  fresh.push(now);
  requestTimestamps.set(userId, fresh);
  return { allowed: true, currentCount: fresh.length, limit: config.maxRequests, retryAfterMs: 0 };
}
