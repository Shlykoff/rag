// app/api/chat/__tests__/route.test.ts
//
// Covers route.ts's getAIProviders() error handling: a no_credentials
// failure -> 422 (no console.error), anything else -> 500 (with
// console.error) -- neither should ever escape as a bare, undocumented 500.
// See route.ts's module header for the full wire contract nextjs-frontend's
// "add a key" modal depends on. Also covers the ownership check
// (verifyProjectOwnership -> 404, not 403, on mismatch).
//
// Every dependency route.ts imports is mocked here so this test exercises
// only route.ts's own control flow (auth passes, ownership passes, rate
// limit passes, THEN the provider lookup fails), not the real Supabase/
// AI-SDK integrations (those are covered elsewhere: lib/chat/__tests__, the
// *.integration.test.ts suite).

import { afterEach, describe, expect, it, vi } from "vitest";

const mockGetRouteHandlerSupabaseClient = vi.fn();
const mockGetAuthenticatedUser = vi.fn();
const mockVerifyProjectOwnership = vi.fn();
const mockGetServiceRoleClient = vi.fn();
const mockReserveChatRateLimitSlot = vi.fn();
const mockGetAIProviders = vi.fn();
const mockHandleChatRequest = vi.fn();

vi.mock("@/lib/supabase/server-client", () => ({
  getRouteHandlerSupabaseClient: () => mockGetRouteHandlerSupabaseClient(),
  getAuthenticatedUser: (client: unknown) => mockGetAuthenticatedUser(client),
  verifyProjectOwnership: (...args: unknown[]) => mockVerifyProjectOwnership(...args),
}));

vi.mock("@/lib/supabase/service-client", () => ({
  getServiceRoleClient: () => mockGetServiceRoleClient(),
}));

vi.mock("@/lib/rate-limit/rate-limiter", () => ({
  reserveChatRateLimitSlot: (...args: unknown[]) => mockReserveChatRateLimitSlot(...args),
}));

// AIProviderError itself is the REAL class (imported from lib/ai/errors,
// which has no DB/network dependency) so `err instanceof AIProviderError`
// inside route.ts still works against errors this test throws from the
// mocked getAIProviders() -- only getAIProviders() itself (the DB-backed
// per-project lookup) is faked.
vi.mock("@/lib/ai", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/errors")>("@/lib/ai/errors");
  return {
    getAIProviders: (...args: unknown[]) => mockGetAIProviders(...args),
    AIProviderError: actual.AIProviderError,
  };
});

vi.mock("@/lib/chat/handle-chat-request", () => ({
  handleChatRequest: (...args: unknown[]) => mockHandleChatRequest(...args),
}));

import { POST } from "../route";
import { AIProviderError } from "@/lib/ai/errors";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

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

  it("returns 401 when there is no session, without checking project ownership or rate limiting", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue(null);

    const response = await POST(makeRequest({ projectId: PROJECT_ID, message: "hello" }));

    expect(response.status).toBe(401);
    expect(mockVerifyProjectOwnership).not.toHaveBeenCalled();
    expect(mockReserveChatRateLimitSlot).not.toHaveBeenCalled();
  });

  it("returns 400 { error: 'invalid_request' } when projectId is missing/malformed, before any ownership/rate-limit check", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });

    const response = await POST(makeRequest({ message: "hello" }));

    expect(response.status).toBe(400);
    expect(mockVerifyProjectOwnership).not.toHaveBeenCalled();
  });

  it("returns 404 { error: 'not_found' } (not 403) when the project doesn't belong to the signed-in user, without rate-limiting or calling the AI provider", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(false);

    const response = await POST(makeRequest({ projectId: PROJECT_ID, message: "hello" }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(mockReserveChatRateLimitSlot).not.toHaveBeenCalled();
    expect(mockGetAIProviders).not.toHaveBeenCalled();
  });

  it("returns 500 { error: 'provider_unavailable' } (not a bare/empty 500) when getAIProviders() rejects with a non-AIProviderError, logs via console.error, and still releases the reserved rate-limit slot", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockGetServiceRoleClient.mockReturnValue({});
    const release = vi.fn();
    mockReserveChatRateLimitSlot.mockResolvedValue({
      allowed: true,
      currentCount: 0,
      limit: 10,
      release,
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetAIProviders.mockRejectedValue(new Error("getServiceRoleClient(): boom, a real DB/config fault"));

    const response = await POST(makeRequest({ projectId: PROJECT_ID, message: "hello" }));

    expect(response.status).toBe(500);
    // The pre-fix bug produced an empty body / no Content-Type -- assert
    // the response is real JSON with the documented error shape, not just
    // a non-2xx status.
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    const payload = await response.json();
    expect(payload).toMatchObject({ error: "provider_unavailable" });
    expect(payload.message).toBeTruthy();

    // A real, unexpected fault DOES get logged -- unlike the no_credentials
    // case below, which deliberately does not (see the next test).
    expect(consoleErrorSpy).toHaveBeenCalled();

    // handleChatRequest (which would call the AI provider) must never be
    // reached once getAIProviders() has already failed.
    expect(mockHandleChatRequest).not.toHaveBeenCalled();

    // The rate-limit slot reserved earlier in this same request must be
    // released on this early-return path too -- otherwise every failed
    // request due to a misconfigured provider would leak a reservation for
    // up to the rate limit window (see rate-limiter.ts's release() comment).
    expect(release).toHaveBeenCalledTimes(1);
    consoleErrorSpy.mockRestore();
  });

  it("returns 422 { error: 'no_credentials' } (NOT 500) when getAIProviders() rejects with AIProviderError{kind:'no_credentials'}, and does NOT log via console.error", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockGetServiceRoleClient.mockReturnValue({});
    const release = vi.fn();
    mockReserveChatRateLimitSlot.mockResolvedValue({
      allowed: true,
      currentCount: 0,
      limit: 10,
      release,
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetAIProviders.mockRejectedValue(
      new AIProviderError({
        provider: "none",
        kind: "no_credentials",
        retryable: false,
        message: `getAIProviders: project ${PROJECT_ID} has no active_ai_provider set.`,
        userMessage: "Добавьте и выберите AI-провайдера для этого проекта, чтобы начать общаться с ассистентом.",
      })
    );

    const response = await POST(makeRequest({ projectId: PROJECT_ID, message: "hello" }));

    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    const payload = await response.json();
    // Wire contract nextjs-frontend's "add a key" modal is built against --
    // see route.ts's module header.
    expect(payload).toMatchObject({ error: "no_credentials" });
    expect(payload.message).toBeTruthy();

    // This is the entire point of the split: an expected "project hasn't
    // configured a provider yet" state must never be logged as a server
    // error -- see route.ts's module header comment on why that would
    // drown out real 500s.
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    expect(mockHandleChatRequest).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    consoleErrorSpy.mockRestore();
  });

  it("still returns a normal 200 SSE response when getAIProviders() succeeds, calling it with {projectId, ownerUserId}", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockGetServiceRoleClient.mockReturnValue({});
    const release = vi.fn();
    mockReserveChatRateLimitSlot.mockResolvedValue({
      allowed: true,
      currentCount: 0,
      limit: 10,
      release,
    });
    mockGetAIProviders.mockResolvedValue({
      chatProvider: { providerName: "fake" },
      embeddingsProvider: { providerName: "fake" },
    });
    async function* fakeEvents() {
      yield { type: "conversation", conversationId: "11111111-1111-1111-1111-111111111111" };
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
    }
    mockHandleChatRequest.mockReturnValue(fakeEvents());

    const response = await POST(makeRequest({ projectId: PROJECT_ID, message: "hello" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);
    const text = await response.text();
    expect(text).toContain("event: conversation");
    expect(text).toContain("event: done");
    expect(release).toHaveBeenCalledTimes(1);
    // getAIProviders() is now project-scoped, bring-your-own-key -- the
    // project id + its owner's user id and the service-role client must be
    // threaded through, not called with no arguments.
    expect(mockGetAIProviders).toHaveBeenCalledWith({ projectId: PROJECT_ID, ownerUserId: "user-1" }, {});
    // Rate limiting is keyed by projectId now, shared across owner test
    // chat + external channel sessions.
    expect(mockReserveChatRateLimitSlot).toHaveBeenCalledWith({}, PROJECT_ID);
  });
});
