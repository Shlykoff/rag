// lib/rate-limit/__tests__/sliding-window.test.ts
//
// Unit tests for the shared sliding-window primitive extracted out of what
// used to be four independent copy-pasted implementations of the same
// logic -- see sliding-window.ts's own header. The per-module wrapper
// tests (channel-participant/source-ingest/ai-credentials-rate-limiter.test.ts)
// already cover this logic indirectly through each module's own public API;
// this file tests the shared primitive directly, including the one thing
// those wrapper tests can't see: that two independently-created limiters
// never share state.

import { describe, expect, it, vi } from "vitest";
import { createSlidingWindowLimiter, purgeExpired } from "../sliding-window";

describe("createSlidingWindowLimiter", () => {
  it("allows requests up to maxEntries within the window, then rejects", () => {
    const limiter = createSlidingWindowLimiter({ windowMs: 60_000, maxEntries: 3 });

    expect(limiter.check("key-a").allowed).toBe(true);
    expect(limiter.check("key-a").allowed).toBe(true);
    const third = limiter.check("key-a");
    expect(third.allowed).toBe(true);
    expect(third.currentCount).toBe(3);

    const fourth = limiter.check("key-a");
    expect(fourth.allowed).toBe(false);
    expect(fourth.currentCount).toBe(3);
    expect(fourth.limit).toBe(3);
    expect(fourth.retryAfterMs).toBeGreaterThan(0);
  });

  it("tracks each key's window completely independently", () => {
    const limiter = createSlidingWindowLimiter({ windowMs: 60_000, maxEntries: 1 });

    expect(limiter.check("key-a").allowed).toBe(true);
    expect(limiter.check("key-a").allowed).toBe(false); // key-a is now at its limit
    expect(limiter.check("key-b").allowed).toBe(true); // key-b is unaffected
  });

  it("two independently-created limiters never share state, even with identical keys/config", () => {
    const config = { windowMs: 60_000, maxEntries: 1 };
    const limiterOne = createSlidingWindowLimiter(config);
    const limiterTwo = createSlidingWindowLimiter(config);

    expect(limiterOne.check("same-key").allowed).toBe(true);
    expect(limiterOne.check("same-key").allowed).toBe(false); // limiterOne is now exhausted for this key

    // limiterTwo has never seen "same-key" before -- its own, separate Map.
    expect(limiterTwo.check("same-key").allowed).toBe(true);
  });

  it("allows a request again once the window has elapsed", () => {
    vi.useFakeTimers();
    try {
      const limiter = createSlidingWindowLimiter({ windowMs: 1000, maxEntries: 1 });
      expect(limiter.check("key-a").allowed).toBe(true);
      expect(limiter.check("key-a").allowed).toBe(false);

      vi.advanceTimersByTime(1001);
      expect(limiter.check("key-a").allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a per-call config overrides the limiter's own default", () => {
    const limiter = createSlidingWindowLimiter({ windowMs: 60_000, maxEntries: 1 });
    expect(limiter.check("key-a").allowed).toBe(true);
    // Would be rejected under the default maxEntries: 1, but this call
    // supplies a looser config.
    const result = limiter.check("key-a", { windowMs: 60_000, maxEntries: 5 });
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(5);
  });

  it("reset() clears all keys' recorded state", () => {
    const limiter = createSlidingWindowLimiter({ windowMs: 60_000, maxEntries: 1 });
    limiter.check("key-a");
    expect(limiter.check("key-a").allowed).toBe(false);

    limiter.reset();
    expect(limiter.check("key-a").allowed).toBe(true);
  });
});

describe("purgeExpired", () => {
  it("drops entries older than windowMs and writes the filtered list back", () => {
    const store = new Map<string, number[]>([["key-a", [1000, 5000, 9000]]]);
    const fresh = purgeExpired(store, "key-a", 3000, 10_000); // cutoff = 7000
    expect(fresh).toEqual([9000]);
    expect(store.get("key-a")).toEqual([9000]);
  });

  it("removes the key entirely once every entry has expired", () => {
    const store = new Map<string, number[]>([["key-a", [1000, 2000]]]);
    const fresh = purgeExpired(store, "key-a", 100, 10_000);
    expect(fresh).toEqual([]);
    expect(store.has("key-a")).toBe(false);
  });

  it("returns an empty array (without throwing) for a key that was never recorded", () => {
    const store = new Map<string, number[]>();
    expect(purgeExpired(store, "never-seen", 1000)).toEqual([]);
  });
});
