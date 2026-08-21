import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkChannelParticipantRateLimit,
  channelParticipantKey,
  __resetChannelParticipantRateLimitForTests,
  type ChannelParticipantRateLimitConfig,
} from "../channel-participant-rate-limiter";

const config: ChannelParticipantRateLimitConfig = { maxRequests: 3, windowMs: 60_000 };

describe("checkChannelParticipantRateLimit", () => {
  afterEach(() => {
    // requestTimestamps is module-level state -- reset between tests so
    // one test's requests can't leak into the next (same pattern as
    // lib/rate-limit/__tests__/source-ingest-rate-limiter.test.ts's own
    // reset call).
    __resetChannelParticipantRateLimitForTests();
  });

  it("allows requests under the limit", () => {
    const first = checkChannelParticipantRateLimit("project-1", "telegram", "participant-1", config);
    expect(first.allowed).toBe(true);
    expect(first.currentCount).toBe(1);
    expect(first.limit).toBe(3);

    const second = checkChannelParticipantRateLimit("project-1", "telegram", "participant-1", config);
    expect(second.allowed).toBe(true);
    expect(second.currentCount).toBe(2);
  });

  it("blocks once the participant hits maxRequests within the window", () => {
    checkChannelParticipantRateLimit("project-1", "telegram", "participant-1", config);
    checkChannelParticipantRateLimit("project-1", "telegram", "participant-1", config);
    checkChannelParticipantRateLimit("project-1", "telegram", "participant-1", config);
    const fourth = checkChannelParticipantRateLimit("project-1", "telegram", "participant-1", config);
    expect(fourth.allowed).toBe(false);
    expect(fourth.currentCount).toBe(3);
    expect(fourth.limit).toBe(3);
  });

  it("does not let one participant's messages consume another participant's slots -- even within the SAME project/channel", () => {
    checkChannelParticipantRateLimit("project-1", "telegram", "participant-a", config);
    checkChannelParticipantRateLimit("project-1", "telegram", "participant-a", config);
    checkChannelParticipantRateLimit("project-1", "telegram", "participant-a", config);
    // participant-a is now at the limit -- participant-b (same project,
    // same channel) must be unaffected.
    const participantB = checkChannelParticipantRateLimit("project-1", "telegram", "participant-b", config);
    expect(participantB.allowed).toBe(true);
    expect(participantB.currentCount).toBe(1);
  });

  it("scopes by project too -- the SAME externalParticipantId in a DIFFERENT project is an independent bucket", () => {
    checkChannelParticipantRateLimit("project-1", "telegram", "participant-a", config);
    checkChannelParticipantRateLimit("project-1", "telegram", "participant-a", config);
    checkChannelParticipantRateLimit("project-1", "telegram", "participant-a", config);
    const otherProject = checkChannelParticipantRateLimit("project-2", "telegram", "participant-a", config);
    expect(otherProject.allowed).toBe(true);
    expect(otherProject.currentCount).toBe(1);
  });

  it("old requests age out of the window and free up slots again", () => {
    vi.useFakeTimers();
    try {
      const windowConfig: ChannelParticipantRateLimitConfig = { maxRequests: 1, windowMs: 1_000 };
      const first = checkChannelParticipantRateLimit("project-1", "telegram", "participant-1", windowConfig);
      expect(first.allowed).toBe(true);

      const second = checkChannelParticipantRateLimit("project-1", "telegram", "participant-1", windowConfig);
      expect(second.allowed).toBe(false);

      vi.advanceTimersByTime(1_001);

      const third = checkChannelParticipantRateLimit("project-1", "telegram", "participant-1", windowConfig);
      expect(third.allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the default config (5 requests / 60s) when none is provided", () => {
    const result = checkChannelParticipantRateLimit("project-1", "telegram", "participant-1");
    expect(result.limit).toBe(5);
    expect(result.allowed).toBe(true);
  });
});

describe("channelParticipantKey", () => {
  it("is a stable, order-sensitive composite of (projectId, channel, externalParticipantId)", () => {
    expect(channelParticipantKey("p1", "telegram", "u1")).toBe("p1:telegram:u1");
    expect(channelParticipantKey("p1", "telegram", "u1")).toBe(channelParticipantKey("p1", "telegram", "u1"));
    expect(channelParticipantKey("p1", "telegram", "u2")).not.toBe(channelParticipantKey("p1", "telegram", "u1"));
  });
});
