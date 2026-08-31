import { describe, expect, it } from "vitest";
import { rateLimitedResponse } from "../rate-limited-response";

describe("rateLimitedResponse", () => {
  it("returns a 429 with the given message and retryAfterMs in the body", async () => {
    const response = rateLimitedResponse("Слишком много запросов.", 3500);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: "rate_limited",
      message: "Слишком много запросов.",
      retryAfterMs: 3500,
    });
  });

  it("sets Retry-After (in whole seconds, rounded up) from retryAfterMs", () => {
    const response = rateLimitedResponse("m", 2500);
    expect(response.headers.get("Retry-After")).toBe("3");
  });

  it("rounds Retry-After up to at least 1 second for a small positive retryAfterMs", () => {
    const response = rateLimitedResponse("m", 1);
    expect(response.headers.get("Retry-After")).toBe("1");
  });
});
