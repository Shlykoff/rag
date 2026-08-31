import { describe, expect, it } from "vitest";
import { AIProviderError, normalizeProviderError } from "../errors";

describe("normalizeProviderError", () => {
  it("classifies 429 as rate_limited and retryable, with a Russian user message", () => {
    const err = normalizeProviderError({ status: 429, message: "Too Many Requests" }, "openai");
    expect(err).toBeInstanceOf(AIProviderError);
    expect(err.kind).toBe("rate_limited");
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(429);
    expect(err.provider).toBe("openai");
    expect(err.userMessage).toMatch(/перегружен/);
  });

  it("classifies 500-599 as server_error and retryable", () => {
    for (const status of [500, 502, 503, 599]) {
      const err = normalizeProviderError({ status }, "anthropic");
      expect(err.kind).toBe("server_error");
      expect(err.retryable).toBe(true);
    }
  });

  it("classifies other 4xx as invalid_request and NOT retryable", () => {
    const err = normalizeProviderError({ status: 400, message: "bad request" }, "gemini");
    expect(err.kind).toBe("invalid_request");
    expect(err.retryable).toBe(false);
  });

  it("reads statusCode (Voyage/AI-SDK shape) in addition to status", () => {
    const err = normalizeProviderError({ statusCode: 429 }, "voyage");
    expect(err.kind).toBe("rate_limited");
  });

  it("reads response.status (some SDKs nest it) in addition to top-level status", () => {
    const err = normalizeProviderError({ response: { status: 503 } }, "openai");
    expect(err.kind).toBe("server_error");
  });

  it("trusts an explicit isRetryable hint when no status is present", () => {
    const retryable = normalizeProviderError({ isRetryable: true, message: "network blip" }, "openai");
    expect(retryable.retryable).toBe(true);

    const notRetryable = normalizeProviderError({ isRetryable: false, message: "bad input" }, "openai");
    expect(notRetryable.retryable).toBe(false);
  });

  it("classifies network-shaped errors (AbortError / errno) as retryable network errors", () => {
    const timeout = normalizeProviderError({ name: "AbortError", message: "The operation was aborted" }, "openai");
    expect(timeout.kind).toBe("network");
    expect(timeout.retryable).toBe(true);

    const dns = normalizeProviderError({ errno: -3008, code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND" }, "openai");
    expect(dns.kind).toBe("network");
    expect(dns.retryable).toBe(true);
  });

  // Regression test: Voyage (paired with anthropic for embeddings, see
  // lib/ai/index.ts) throws error shapes that don't match any generic
  // errno/code/cause/AbortError check -- verified live against
  // node_modules/voyageai's actual error classes (dist/esm/errors/*.mjs).
  // Constructed here exactly as those classes actually shape their
  // instances (a bare Error subclass with only `.name` set), not a
  // hypothetical/simplified stand-in.
  it("classifies a real-shaped VoyageAITimeoutError as a retryable network error", () => {
    const timeoutErr = Object.assign(new Error("Timeout exceeded when calling POST /v1/embeddings."), {
      name: "VoyageAITimeoutError",
    });
    const err = normalizeProviderError(timeoutErr, "voyage");
    expect(err.kind).toBe("network");
    expect(err.retryable).toBe(true);
  });

  it("classifies a real-shaped, status-less VoyageAIError (connection failure) as a retryable network error", () => {
    // Voyage's Fetcher.mjs discards the underlying TypeError's own
    // errno/code/cause for a connection-level failure and rethrows as a
    // bare VoyageAIError with no statusCode/body/rawResponse at all.
    const connectionErr = Object.assign(new Error("fetch failed"), {
      name: "VoyageAIError",
      statusCode: undefined,
      body: undefined,
      rawResponse: undefined,
    });
    const err = normalizeProviderError(connectionErr, "voyage");
    expect(err.kind).toBe("network");
    expect(err.retryable).toBe(true);
  });

  it("still classifies a real-shaped VoyageAIError WITH a statusCode by that status, not as a network error", () => {
    const rateLimited = Object.assign(new Error("Status code: 429"), {
      name: "VoyageAIError",
      statusCode: 429,
    });
    const err = normalizeProviderError(rateLimited, "voyage");
    expect(err.kind).toBe("rate_limited");
    expect(err.retryable).toBe(true);
  });

  it("falls back to 'unknown', not retryable, for totally unrecognized errors", () => {
    const err = normalizeProviderError("a plain string error", "openai");
    expect(err.kind).toBe("unknown");
    expect(err.retryable).toBe(false);
  });

  it("passes an existing AIProviderError through unchanged (idempotent)", () => {
    const original = new AIProviderError({
      provider: "openai",
      kind: "rate_limited",
      retryable: true,
      message: "m",
      userMessage: "u",
    });
    expect(normalizeProviderError(original, "openai")).toBe(original);
  });
});
