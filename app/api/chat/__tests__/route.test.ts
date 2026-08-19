// app/api/chat/__tests__/route.test.ts
//
// Regression test for the bug qa-reviewer reproduced live via curl:
// getAIProviders() (see lib/ai/index.ts) throws SYNCHRONOUSLY when
// AI_PROVIDER/its matching *_API_KEY env var is missing or invalid. Before
// the fix, that call sat outside any try/catch in POST(), so the throw
// propagated all the way out of the route handler -> a bare HTTP 500 with
// no body and no Content-Type, which is not one of the response shapes
// documented in this route's own header contract (401/400/429/200-SSE).
//
// Every dependency route.ts imports is mocked here so this test exercises
// only route.ts's own control flow (auth passes, rate limit passes, THEN
// the provider lookup fails), not the real Supabase/AI-SDK integrations
// (those are covered elsewhere: lib/chat/__tests__, the *.integration.test.ts
// suite).

import { afterEach, describe, expect, it, vi } from "vitest";

const mockGetRouteHandlerSupabaseClient = vi.fn();
const mockGetAuthenticatedUser = vi.fn();
const mockGetServiceRoleClient = vi.fn();
const mockReserveChatRateLimitSlot = vi.fn();
const mockGetAIProviders = vi.fn();
const mockHandleChatRequest = vi.fn();

vi.mock("@/lib/supabase/server-client", () => ({
  getRouteHandlerSupabaseClient: () => mockGetRouteHandlerSupabaseClient(),
  getAuthenticatedUser: (client: unknown) => mockGetAuthenticatedUser(client),
}));

vi.mock("@/lib/supabase/service-client", () => ({
  getServiceRoleClient: () => mockGetServiceRoleClient(),
}));

vi.mock("@/lib/rate-limit/rate-limiter", () => ({
  reserveChatRateLimitSlot: (...args: unknown[]) => mockReserveChatRateLimitSlot(...args),
}));

vi.mock("@/lib/ai", () => ({
  getAIProviders: () => mockGetAIProviders(),
}));

vi.mock("@/lib/chat/handle-chat-request", () => ({
  handleChatRequest: (...args: unknown[]) => mockHandleChatRequest(...args),
}));

import { POST } from "../route";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/chat", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 500 { error: 'provider_unavailable' } (not a bare/empty 500) when getAIProviders() throws, and still releases the reserved rate-limit slot", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockGetServiceRoleClient.mockReturnValue({});
    const release = vi.fn();
    mockReserveChatRateLimitSlot.mockResolvedValue({
      allowed: true,
      currentCount: 0,
      limit: 10,
      release,
    });
    mockGetAIProviders.mockImplementation(() => {
      throw new Error(
        "Invalid or missing AI_PROVIDER env var (got: undefined). Expected one of: 'openai' | 'anthropic' | 'gemini'. See .env.example."
      );
    });

    const response = await POST(makeRequest({ message: "hello" }));

    expect(response.status).toBe(500);
    // The pre-fix bug produced an empty body / no Content-Type -- assert
    // the response is real JSON with the documented error shape, not just
    // a non-2xx status.
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    const payload = await response.json();
    expect(payload).toMatchObject({ error: "provider_unavailable" });
    expect(payload.message).toBeTruthy();

    // handleChatRequest (which would call the AI provider) must never be
    // reached once getAIProviders() has already failed.
    expect(mockHandleChatRequest).not.toHaveBeenCalled();

    // The rate-limit slot reserved earlier in this same request must be
    // released on this early-return path too -- otherwise every failed
    // request due to a misconfigured provider would leak a reservation for
    // up to the rate limit window (see rate-limiter.ts's release() comment).
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("still returns a normal 200 SSE response when getAIProviders() succeeds", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockGetServiceRoleClient.mockReturnValue({});
    const release = vi.fn();
    mockReserveChatRateLimitSlot.mockResolvedValue({
      allowed: true,
      currentCount: 0,
      limit: 10,
      release,
    });
    mockGetAIProviders.mockReturnValue({
      chatProvider: { providerName: "fake" },
      embeddingsProvider: { providerName: "fake" },
    });
    async function* fakeEvents() {
      yield { type: "conversation", conversationId: "11111111-1111-1111-1111-111111111111" };
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
    }
    mockHandleChatRequest.mockReturnValue(fakeEvents());

    const response = await POST(makeRequest({ message: "hello" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);
    const text = await response.text();
    expect(text).toContain("event: conversation");
    expect(text).toContain("event: done");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
