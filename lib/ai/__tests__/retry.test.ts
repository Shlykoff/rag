import { describe, expect, it, vi } from "vitest";
import { withRetry } from "../retry";
import { AIProviderError } from "../errors";

describe("withRetry", () => {
  it("returns the result immediately on first success, no sleep called", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { provider: "openai", sleep });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries on a retryable (429) error and eventually succeeds", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) {
        const err = { status: 429, message: "rate limited" };
        throw err;
      }
      return "ok-after-retries";
    });
    const result = await withRetry(fn, { provider: "openai", sleep, maxRetries: 3 });
    expect(result).toBe("ok-after-retries");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("uses exponential backoff with increasing delay per attempt", async () => {
    const delays: number[] = [];
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      delays.push(ms);
    });
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls <= 3) throw { status: 500 };
      return "ok";
    });
    await withRetry(fn, { provider: "openai", sleep, maxRetries: 3, baseDelayMs: 100 });
    expect(delays).toHaveLength(3);
    // Each delay should be strictly greater than the floor for its attempt
    // (baseDelayMs * 2^attempt), since jitter only adds on top.
    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[0]).toBeLessThan(200);
    expect(delays[1]).toBeGreaterThanOrEqual(200);
    expect(delays[1]).toBeLessThan(300);
    expect(delays[2]).toBeGreaterThanOrEqual(400);
    expect(delays[2]).toBeLessThan(500);
  });

  it("does not retry a non-retryable (400) error -- throws immediately", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValue({ status: 400, message: "bad request" });
    await expect(withRetry(fn, { provider: "openai", sleep })).rejects.toBeInstanceOf(AIProviderError);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after maxRetries and throws the last normalized error", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValue({ status: 503, message: "down" });
    await expect(
      withRetry(fn, { provider: "anthropic", sleep, maxRetries: 2 })
    ).rejects.toMatchObject({ kind: "server_error", provider: "anthropic" });
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
