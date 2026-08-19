import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkSourceIngestRateLimit,
  __resetSourceIngestRateLimitForTests,
  type SourceIngestRateLimitConfig,
} from "../source-ingest-rate-limiter";

const config: SourceIngestRateLimitConfig = { maxRequests: 3, windowMs: 60_000 };

describe("checkSourceIngestRateLimit", () => {
  afterEach(() => {
    // requestTimestamps is module-level state -- reset between tests so
    // one test's requests can't leak into the next (same pattern as
    // lib/rate-limit/__tests__/rate-limiter.test.ts's
    // __resetRateLimitReservationsForTests).
    __resetSourceIngestRateLimitForTests();
  });

  it("allows requests under the limit", () => {
    const first = checkSourceIngestRateLimit("user-1", config);
    expect(first.allowed).toBe(true);
    expect(first.currentCount).toBe(1);
    expect(first.limit).toBe(3);

    const second = checkSourceIngestRateLimit("user-1", config);
    expect(second.allowed).toBe(true);
    expect(second.currentCount).toBe(2);
  });

  it("blocks once the user hits maxRequests within the window", () => {
    checkSourceIngestRateLimit("user-1", config);
    checkSourceIngestRateLimit("user-1", config);
    checkSourceIngestRateLimit("user-1", config);
    const fourth = checkSourceIngestRateLimit("user-1", config);
    expect(fourth.allowed).toBe(false);
    expect(fourth.currentCount).toBe(3);
    expect(fourth.limit).toBe(3);
  });

  it("retryAfterMs is 0 when allowed, and a positive value close to the window when blocked", () => {
    const allowed = checkSourceIngestRateLimit("user-1", config);
    expect(allowed.retryAfterMs).toBe(0);

    checkSourceIngestRateLimit("user-1", config);
    checkSourceIngestRateLimit("user-1", config);
    const blocked = checkSourceIngestRateLimit("user-1", config);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(config.windowMs);
  });

  it("does not let one user's requests consume another user's slots", () => {
    checkSourceIngestRateLimit("user-a", config);
    checkSourceIngestRateLimit("user-a", config);
    checkSourceIngestRateLimit("user-a", config);
    // user-a is now at the limit -- user-b should be unaffected.
    const userB = checkSourceIngestRateLimit("user-b", config);
    expect(userB.allowed).toBe(true);
    expect(userB.currentCount).toBe(1);
  });

  it("counts N concurrent-in-the-same-tick requests against each other correctly (no await anywhere, so no burst gap to close)", () => {
    // Unlike reserveChatRateLimitSlot, this function has no `await` at
    // all -- calling it N times synchronously in a loop is the accurate
    // simulation of "N requests landing in the same instant", since
    // there's no gap for a stale read to occur across.
    const results = Array.from({ length: 5 }, () => checkSourceIngestRateLimit("burst-user", config));
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    expect(results.filter((r) => !r.allowed)).toHaveLength(2);
  });

  it("old requests age out of the window and free up slots again", () => {
    vi.useFakeTimers();
    try {
      const windowConfig: SourceIngestRateLimitConfig = { maxRequests: 1, windowMs: 1_000 };
      const first = checkSourceIngestRateLimit("user-1", windowConfig);
      expect(first.allowed).toBe(true);

      const second = checkSourceIngestRateLimit("user-1", windowConfig);
      expect(second.allowed).toBe(false);

      vi.advanceTimersByTime(1_001);

      const third = checkSourceIngestRateLimit("user-1", windowConfig);
      expect(third.allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the default config (20 requests / 60s) when none is provided", () => {
    const result = checkSourceIngestRateLimit("user-1");
    expect(result.limit).toBe(20);
    expect(result.allowed).toBe(true);
  });
});
