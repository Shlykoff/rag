// lib/rate-limit/__tests__/ai-credentials-rate-limiter.test.ts
//
// Mirrors lib/rate-limit/__tests__/source-ingest-rate-limiter.test.ts's
// structure exactly, since lib/rate-limit/ai-credentials-rate-limiter.ts
// deliberately reuses that same in-memory sliding-window design (see its
// header for why it's still its own independent module/state map).

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkAICredentialsRateLimit,
  __resetAICredentialsRateLimitForTests,
  type AICredentialsRateLimitConfig,
} from "../ai-credentials-rate-limiter";

const config: AICredentialsRateLimitConfig = { maxRequests: 3, windowMs: 60_000 };

describe("checkAICredentialsRateLimit", () => {
  afterEach(() => {
    __resetAICredentialsRateLimitForTests();
  });

  it("allows requests under the limit", () => {
    const first = checkAICredentialsRateLimit("user-1", config);
    expect(first.allowed).toBe(true);
    expect(first.currentCount).toBe(1);
    expect(first.limit).toBe(3);

    const second = checkAICredentialsRateLimit("user-1", config);
    expect(second.allowed).toBe(true);
    expect(second.currentCount).toBe(2);
  });

  it("blocks once the user hits maxRequests within the window", () => {
    checkAICredentialsRateLimit("user-1", config);
    checkAICredentialsRateLimit("user-1", config);
    checkAICredentialsRateLimit("user-1", config);
    const fourth = checkAICredentialsRateLimit("user-1", config);
    expect(fourth.allowed).toBe(false);
    expect(fourth.currentCount).toBe(3);
    expect(fourth.limit).toBe(3);
  });

  it("retryAfterMs is 0 when allowed, and a positive value close to the window when blocked", () => {
    const allowed = checkAICredentialsRateLimit("user-1", config);
    expect(allowed.retryAfterMs).toBe(0);

    checkAICredentialsRateLimit("user-1", config);
    checkAICredentialsRateLimit("user-1", config);
    const blocked = checkAICredentialsRateLimit("user-1", config);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(config.windowMs);
  });

  it("does not let one user's requests consume another user's slots", () => {
    checkAICredentialsRateLimit("user-a", config);
    checkAICredentialsRateLimit("user-a", config);
    checkAICredentialsRateLimit("user-a", config);
    // user-a is now at the limit -- user-b should be unaffected.
    const userB = checkAICredentialsRateLimit("user-b", config);
    expect(userB.allowed).toBe(true);
    expect(userB.currentCount).toBe(1);
  });

  it("counts N concurrent-in-the-same-tick requests against each other correctly (no await anywhere, so no burst gap to close)", () => {
    const results = Array.from({ length: 5 }, () => checkAICredentialsRateLimit("burst-user", config));
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    expect(results.filter((r) => !r.allowed)).toHaveLength(2);
  });

  it("old requests age out of the window and free up slots again", () => {
    vi.useFakeTimers();
    try {
      const windowConfig: AICredentialsRateLimitConfig = { maxRequests: 1, windowMs: 1_000 };
      const first = checkAICredentialsRateLimit("user-1", windowConfig);
      expect(first.allowed).toBe(true);

      const second = checkAICredentialsRateLimit("user-1", windowConfig);
      expect(second.allowed).toBe(false);

      vi.advanceTimersByTime(1_001);

      const third = checkAICredentialsRateLimit("user-1", windowConfig);
      expect(third.allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the default config (10 requests / 60s) when none is provided", () => {
    const result = checkAICredentialsRateLimit("user-1");
    expect(result.limit).toBe(10);
    expect(result.allowed).toBe(true);
  });
});
