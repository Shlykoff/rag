import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkChatRateLimit,
  reserveChatRateLimitSlot,
  __resetRateLimitReservationsForTests,
  type RateLimitConfig,
} from "../rate-limiter";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Minimal fake of the chainable Postgrest query builder
 * (`.from().select().eq().eq().gte().order()`) that lib/rate-limit's
 * checkChatRateLimit builds and then awaits directly (the real
 * supabase-js builder is itself thenable -- there's no separate
 * `.execute()` call). Records every call for assertions, and resolves to
 * a configurable `{ data, error, count }` result.
 */
function makeFakeSupabase(result: { data: unknown[] | null; error: { message: string } | null; count: number | null }) {
  const calls: { method: string; args: unknown[] }[] = [];

  const builder: Record<string, unknown> = {};
  const chainable = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    return builder;
  };

  builder.select = chainable("select");
  builder.eq = chainable("eq");
  builder.gte = chainable("gte");
  builder.order = chainable("order");
  // `order(...)` is the last call in the chain and its return value is what
  // gets awaited -- make the builder itself thenable so `await ...order(...)`
  // resolves to `result`, exactly like the real Postgrest builder.
  builder.then = (resolve: (value: typeof result) => void) => resolve(result);

  const from = vi.fn().mockReturnValue(builder);
  const fakeClient = { from } as unknown as Pick<SupabaseClient, "from">;

  return { fakeClient, from, calls };
}

const config: RateLimitConfig = { maxRequests: 3, windowMs: 60_000 };

describe("checkChatRateLimit", () => {
  it("allows the request when the user is under the limit", async () => {
    const { fakeClient, from } = makeFakeSupabase({
      data: [{ created_at: new Date().toISOString() }],
      error: null,
      count: 1,
    });
    const result = await checkChatRateLimit(fakeClient, "user-1", config);
    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(1);
    expect(result.limit).toBe(3);
    expect(from).toHaveBeenCalledWith("usage_events");
  });

  it("blocks the request once currentCount reaches maxRequests", async () => {
    const now = Date.now();
    const { fakeClient } = makeFakeSupabase({
      data: [
        { created_at: new Date(now - 30_000).toISOString() },
        { created_at: new Date(now - 20_000).toISOString() },
        { created_at: new Date(now - 10_000).toISOString() },
      ],
      error: null,
      count: 3,
    });
    const result = await checkChatRateLimit(fakeClient, "user-1", config);
    expect(result.allowed).toBe(false);
    expect(result.currentCount).toBe(3);
  });

  it("computes retryAfterMs from the oldest event in the window when blocked", async () => {
    const now = Date.now();
    const oldestAgeMs = 45_000;
    const { fakeClient } = makeFakeSupabase({
      data: [{ created_at: new Date(now - oldestAgeMs).toISOString() }],
      error: null,
      count: 3,
    });
    const result = await checkChatRateLimit(fakeClient, "user-1", { maxRequests: 1, windowMs: 60_000 });
    expect(result.allowed).toBe(false);
    // retryAfterMs should be close to windowMs - oldestAgeMs (15s), allowing
    // for a little test execution slack.
    expect(result.retryAfterMs).toBeGreaterThan(10_000);
    expect(result.retryAfterMs).toBeLessThanOrEqual(15_000);
  });

  it("retryAfterMs is 0 when allowed", async () => {
    const { fakeClient } = makeFakeSupabase({ data: [], error: null, count: 0 });
    const result = await checkChatRateLimit(fakeClient, "user-1", config);
    expect(result.allowed).toBe(true);
    expect(result.retryAfterMs).toBe(0);
  });

  it("scopes the query to the given project_id and event_type = chat_request", async () => {
    const { fakeClient, calls } = makeFakeSupabase({ data: [], error: null, count: 0 });
    await checkChatRateLimit(fakeClient, "project-42", config);
    const eqCalls = calls.filter((c) => c.method === "eq");
    expect(eqCalls).toContainEqual({ method: "eq", args: ["project_id", "project-42"] });
    expect(eqCalls).toContainEqual({ method: "eq", args: ["event_type", "chat_request"] });
  });

  it("throws a descriptive error if the underlying query fails", async () => {
    const { fakeClient } = makeFakeSupabase({ data: null, error: { message: "connection reset" }, count: null });
    await expect(checkChatRateLimit(fakeClient, "user-1", config)).rejects.toThrow(/connection reset/);
  });

  it("uses the default config (10 requests / 60s) when none is provided", async () => {
    const { fakeClient } = makeFakeSupabase({ data: [], error: null, count: 5 });
    const result = await checkChatRateLimit(fakeClient, "user-1");
    expect(result.limit).toBe(10);
    expect(result.allowed).toBe(true);
  });
});

describe("reserveChatRateLimitSlot (Bug 2 fix: parallel-burst gap)", () => {
  afterEach(() => {
    // activeReservations is module-level state -- reset between tests so
    // one test's reservations can't leak into the next.
    __resetRateLimitReservationsForTests();
  });

  it("counts N concurrent requests against each other instead of all reading the same stale DB count -- exactly maxRequests are allowed, not all of them", async () => {
    // Simulates the exact bug scenario: none of these 5 concurrent
    // requests has written its own usage_events row yet (a real
    // chat_request row only lands after that request's full streamed
    // response finishes -- see lib/chat/handle-chat-request.ts), so every
    // one of them queries the SAME `count: 0` from the DB. Without the
    // in-memory reservation layer, checkChatRateLimit alone would let all
    // 5 through against a limit of 3.
    const { fakeClient } = makeFakeSupabase({ data: [], error: null, count: 0 });
    const burstConfig: RateLimitConfig = { maxRequests: 3, windowMs: 60_000 };

    const results = await Promise.all(
      Array.from({ length: 5 }, () => reserveChatRateLimitSlot(fakeClient, "burst-user", burstConfig))
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    expect(results.filter((r) => !r.allowed)).toHaveLength(2);
  });

  it("does not let a burst from one user consume another user's slots", async () => {
    const { fakeClient } = makeFakeSupabase({ data: [], error: null, count: 0 });
    const burstConfig: RateLimitConfig = { maxRequests: 2, windowMs: 60_000 };

    const [userAResults, userBResults] = await Promise.all([
      Promise.all(Array.from({ length: 3 }, () => reserveChatRateLimitSlot(fakeClient, "user-a", burstConfig))),
      Promise.all(Array.from({ length: 3 }, () => reserveChatRateLimitSlot(fakeClient, "user-b", burstConfig))),
    ]);

    expect(userAResults.filter((r) => r.allowed)).toHaveLength(2);
    expect(userBResults.filter((r) => r.allowed)).toHaveLength(2);
  });

  it("release() frees the reserved slot for a subsequent request by the same user", async () => {
    const { fakeClient } = makeFakeSupabase({ data: [], error: null, count: 0 });
    const singleSlotConfig: RateLimitConfig = { maxRequests: 1, windowMs: 60_000 };

    const first = await reserveChatRateLimitSlot(fakeClient, "release-user", singleSlotConfig);
    expect(first.allowed).toBe(true);

    const second = await reserveChatRateLimitSlot(fakeClient, "release-user", singleSlotConfig);
    expect(second.allowed).toBe(false); // the one slot is still held by `first`

    if (first.allowed) first.release();

    const third = await reserveChatRateLimitSlot(fakeClient, "release-user", singleSlotConfig);
    expect(third.allowed).toBe(true); // freed by release()
  });

  it("release() is idempotent -- calling it twice does not free two slots", async () => {
    const { fakeClient } = makeFakeSupabase({ data: [], error: null, count: 0 });
    const twoSlotConfig: RateLimitConfig = { maxRequests: 2, windowMs: 60_000 };

    const first = await reserveChatRateLimitSlot(fakeClient, "idempotent-user", twoSlotConfig);
    const second = await reserveChatRateLimitSlot(fakeClient, "idempotent-user", twoSlotConfig);
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);

    if (first.allowed) {
      first.release();
      first.release(); // second call must be a no-op, not free a slot that isn't held
    }

    // Only `first`'s slot was freed -- `second` still holds one, so exactly
    // one more request should be allowed, not two.
    const third = await reserveChatRateLimitSlot(fakeClient, "idempotent-user", twoSlotConfig);
    const fourth = await reserveChatRateLimitSlot(fakeClient, "idempotent-user", twoSlotConfig);
    expect(third.allowed).toBe(true);
    expect(fourth.allowed).toBe(false);
  });

  it("does not reserve when already over the DB-only count", async () => {
    const { fakeClient } = makeFakeSupabase({
      data: [{ created_at: new Date().toISOString() }],
      error: null,
      count: 5,
    });
    const result = await reserveChatRateLimitSlot(fakeClient, "over-user", { maxRequests: 3, windowMs: 60_000 });
    expect(result.allowed).toBe(false);
  });
});
