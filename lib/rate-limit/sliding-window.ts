// lib/rate-limit/sliding-window.ts
//
// Generic in-memory sliding-window rate limiting: filter timestamps older
// than the window out of a `Map<string, number[]>`, compare the remaining
// count against a max, push-and-store a new one. Shared by:
//   - lib/rate-limit/channel-participant-rate-limiter.ts
//   - lib/rate-limit/source-ingest-rate-limiter.ts
//   - lib/rate-limit/ai-credentials-rate-limiter.ts
//   - lib/rate-limit/rate-limiter.ts's own in-process reservation layer
//     (a near-variant -- see purgeExpired()'s own doc comment for why it
//     reuses just the shared filtering step, not the full check-and-record
//     API the other three call sites want)
//
// Each of the first three modules instantiates its own
// createSlidingWindowLimiter() so their Map state stays fully independent
// (e.g. a user hammering source ingestion must never eat into their
// unrelated AI-credentials write budget). Every module keeps its own
// public function names and result shapes -- this file is purely an
// internal implementation detail each one delegates to.

/** Drops `key`'s recorded timestamps in `store` older than `windowMs` (relative to `now`), writing the filtered list back -- or removing the key entirely once it's empty, so the map never accumulates stale entries for keys that stop being used. Returns the post-purge list. Exported (not just used internally by createSlidingWindowLimiter below) specifically for lib/rate-limit/rate-limiter.ts's in-process reservation layer, whose "reserve a slot now, release it later by removing that EXACT timestamp value" shape doesn't fit createSlidingWindowLimiter's own record-immediately-and-return contract -- it still wants this exact filtering step against its own Map, just without the rest of the record/decide logic. */
export function purgeExpired(
  store: Map<string, number[]>,
  key: string,
  windowMs: number,
  now: number = Date.now()
): number[] {
  const existing = store.get(key);
  if (!existing) return [];
  const fresh = existing.filter((ts) => ts > now - windowMs);
  if (fresh.length > 0) store.set(key, fresh);
  else store.delete(key);
  return fresh;
}

export interface SlidingWindowConfig {
  windowMs: number;
  /** Max entries allowed within `windowMs`, per key. */
  maxEntries: number;
}

export interface SlidingWindowCheckResult {
  allowed: boolean;
  /** How many entries this key has in the current window -- INCLUDING this one when allowed. */
  currentCount: number;
  limit: number;
  /** Milliseconds until the oldest entry in the window ages out -- a reasonable "try again in" hint. Only meaningful when allowed === false. */
  retryAfterMs: number;
}

export interface SlidingWindowLimiter {
  /**
   * Checks AND records one attempt for `key`, atomically -- no `await`
   * anywhere in this function, so Node's single-threaded event loop means
   * no other call for the same key can interleave inside it, closing the
   * "check, then separately record" race a naive split implementation
   * would leave open for a parallel burst. `config` overrides this
   * limiter's own default per call, for callers (like
   * lib/rate-limit/ai-credentials-rate-limiter.ts's exported function) that
   * accept a config parameter themselves rather than hardcoding one.
   */
  check(key: string, config?: SlidingWindowConfig): SlidingWindowCheckResult;
  /** Test-only escape hatch: clears ALL keys' recorded state. Each module wraps this with its own `__reset*ForTests` name so existing test imports don't need to change. */
  reset(): void;
}

/** Instantiates one independent sliding-window limiter (its own private `Map`, never shared with any other call site) with `defaultConfig` applied whenever a caller of `.check()` doesn't override it. */
export function createSlidingWindowLimiter(defaultConfig: SlidingWindowConfig): SlidingWindowLimiter {
  const store = new Map<string, number[]>();

  function check(key: string, config: SlidingWindowConfig = defaultConfig): SlidingWindowCheckResult {
    const now = Date.now();
    const fresh = purgeExpired(store, key, config.windowMs, now);

    if (fresh.length >= config.maxEntries) {
      const oldest = fresh[0];
      return {
        allowed: false,
        currentCount: fresh.length,
        limit: config.maxEntries,
        retryAfterMs: Math.max(0, oldest + config.windowMs - now),
      };
    }

    fresh.push(now);
    store.set(key, fresh);
    return { allowed: true, currentCount: fresh.length, limit: config.maxEntries, retryAfterMs: 0 };
  }

  function reset(): void {
    store.clear();
  }

  return { check, reset };
}
