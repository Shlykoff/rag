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
import { createSlidingWindowLimiter } from "./sliding-window";

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

// Own private limiter instance (its own Map, independent of every other
// module's) -- see lib/rate-limit/sliding-window.ts's header for why each
// call site instantiates separately rather than sharing one. Also shared,
// under its own "telegram:"-prefixed key namespace, by
// app/api/projects/[projectId]/channels/telegram/route.ts's connect/
// disconnect endpoints (see that route's own rateLimitKey() comment) --
// this module doesn't interpret the key beyond using it as the Map key, so
// a second caller with its own key prefix is exactly as isolated from this
// module's own /api/profile/ai-providers callers as two different keys
// always are.
const limiter = createSlidingWindowLimiter({
  windowMs: DEFAULT_AI_CREDENTIALS_RATE_LIMIT.windowMs,
  maxEntries: DEFAULT_AI_CREDENTIALS_RATE_LIMIT.maxRequests,
});

/** Test-only escape hatch: the limiter's Map is module-level state that would otherwise leak between test cases run in the same process. Not meant to be reached for outside lib/rate-limit/__tests__. */
export function __resetAICredentialsRateLimitForTests(): void {
  limiter.reset();
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
  const result = limiter.check(userId, { windowMs: config.windowMs, maxEntries: config.maxRequests });
  return { allowed: result.allowed, currentCount: result.currentCount, limit: result.limit, retryAfterMs: result.retryAfterMs };
}
