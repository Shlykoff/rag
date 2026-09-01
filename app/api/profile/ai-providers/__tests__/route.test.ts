// app/api/profile/ai-providers/__tests__/route.test.ts
//
// Unit test for GET/POST/DELETE /api/profile/ai-providers: exercises each
// handler's own control flow (auth -> rate limit on the state-changing
// methods -> body validation -> the right lib/ai/credentials.ts call ->
// response shape) against mocked dependencies, mirroring
// app/api/chat/__tests__/route.test.ts's / app/api/sources/[documentId]/
// __tests__/route.test.ts's style.
//
// This route has no PUT method or `activeProvider` concept:
// `active_ai_provider` is a per-project setting (see route.ts's own header
// comment). This file only covers the account-level credential CRUD.

import { afterEach, describe, expect, it, vi } from "vitest";

const mockGetRouteHandlerSupabaseClient = vi.fn();
const mockGetAuthenticatedUser = vi.fn();
const mockGetServiceRoleClient = vi.fn();
const mockSaveAIProviderCredential = vi.fn();
const mockGetConfiguredProvidersMap = vi.fn();
const mockDeleteAIProviderCredential = vi.fn();
const mockCheckAICredentialsRateLimit = vi.fn();

vi.mock("@/lib/supabase/server-client", () => ({
  getRouteHandlerSupabaseClient: () => mockGetRouteHandlerSupabaseClient(),
  getAuthenticatedUser: (client: unknown) => mockGetAuthenticatedUser(client),
}));

vi.mock("@/lib/supabase/service-client", () => ({
  getServiceRoleClient: () => mockGetServiceRoleClient(),
}));

vi.mock("@/lib/ai", () => ({
  saveAIProviderCredential: (...args: unknown[]) => mockSaveAIProviderCredential(...args),
  getConfiguredProvidersMap: (...args: unknown[]) => mockGetConfiguredProvidersMap(...args),
  deleteAIProviderCredential: (...args: unknown[]) => mockDeleteAIProviderCredential(...args),
}));

vi.mock("@/lib/rate-limit/ai-credentials-rate-limiter", () => ({
  checkAICredentialsRateLimit: (...args: unknown[]) => mockCheckAICredentialsRateLimit(...args),
}));

import { GET, POST, DELETE } from "../route";

function makeRequest(method: string, body?: unknown): Request {
  return new Request("http://localhost/api/profile/ai-providers", {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const ALLOWED_RATE_LIMIT = { allowed: true as const, currentCount: 1, limit: 10, retryAfterMs: 0 };

describe("GET /api/profile/ai-providers", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 401 when there is no session, without touching the DB", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(mockGetServiceRoleClient).not.toHaveBeenCalled();
  });

  it("returns 200 with per-provider configured booleans, never a key value or an active-provider field", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockGetServiceRoleClient.mockReturnValue({});
    mockGetConfiguredProvidersMap.mockResolvedValue({ openai: true, anthropic: false, gemini: false, voyage: true });

    const response = await GET();

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      configured: { openai: true, anthropic: false, gemini: false, voyage: true },
    });
    expect(payload.activeProvider).toBeUndefined();
    // Never leaks a key -- the response has no field beyond the documented
    // shape that could carry one.
    expect(JSON.stringify(payload)).not.toMatch(/sk-|apiKey/i);
  });
});

describe("POST /api/profile/ai-providers", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 401 when there is no session, without checking the rate limit or touching the DB", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue(null);

    const response = await POST(makeRequest("POST", { provider: "openai", apiKey: "sk-x" }));

    expect(response.status).toBe(401);
    expect(mockCheckAICredentialsRateLimit).not.toHaveBeenCalled();
    expect(mockSaveAIProviderCredential).not.toHaveBeenCalled();
  });

  it("returns 429 { error: 'rate_limited', retryAfterMs } with a Retry-After header when over the limit, before touching the DB", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockCheckAICredentialsRateLimit.mockReturnValue({ allowed: false, currentCount: 10, limit: 10, retryAfterMs: 4200 });

    const response = await POST(makeRequest("POST", { provider: "openai", apiKey: "sk-x" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("5"); // ceil(4200 / 1000)
    const payload = await response.json();
    expect(payload).toMatchObject({ error: "rate_limited", retryAfterMs: 4200 });
    expect(mockSaveAIProviderCredential).not.toHaveBeenCalled();
  });

  it("returns 400 { error: 'invalid_request' } for an unknown provider value", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockCheckAICredentialsRateLimit.mockReturnValue(ALLOWED_RATE_LIMIT);

    const response = await POST(makeRequest("POST", { provider: "not-a-real-provider", apiKey: "sk-x" }));

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toBe("invalid_request");
    expect(mockSaveAIProviderCredential).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty apiKey", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockCheckAICredentialsRateLimit.mockReturnValue(ALLOWED_RATE_LIMIT);

    const response = await POST(makeRequest("POST", { provider: "openai", apiKey: "" }));

    expect(response.status).toBe(400);
  });

  it("returns 400 for malformed JSON", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockCheckAICredentialsRateLimit.mockReturnValue(ALLOWED_RATE_LIMIT);

    const badRequest = new Request("http://localhost/api/profile/ai-providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const response = await POST(badRequest);
    expect(response.status).toBe(400);
  });

  it("saves the credential and returns 200 { status: 'saved' } on a valid request, for every provider including voyage", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockGetServiceRoleClient.mockReturnValue({});
    mockCheckAICredentialsRateLimit.mockReturnValue(ALLOWED_RATE_LIMIT);
    mockSaveAIProviderCredential.mockResolvedValue(undefined);

    const response = await POST(makeRequest("POST", { provider: "voyage", apiKey: "pa-real-key" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "saved" });
    expect(mockSaveAIProviderCredential).toHaveBeenCalledWith({}, "user-1", "voyage", "pa-real-key");
  });
});

describe("DELETE /api/profile/ai-providers", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 401 when there is no session", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue(null);

    const response = await DELETE(makeRequest("DELETE", { provider: "openai" }));
    expect(response.status).toBe(401);
    expect(mockDeleteAIProviderCredential).not.toHaveBeenCalled();
  });

  it("returns 429 when over the limit", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockCheckAICredentialsRateLimit.mockReturnValue({ allowed: false, currentCount: 10, limit: 10, retryAfterMs: 1000 });

    const response = await DELETE(makeRequest("DELETE", { provider: "openai" }));
    expect(response.status).toBe(429);
    expect(mockDeleteAIProviderCredential).not.toHaveBeenCalled();
  });

  it("returns 400 for an unknown provider value", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockCheckAICredentialsRateLimit.mockReturnValue(ALLOWED_RATE_LIMIT);

    const response = await DELETE(makeRequest("DELETE", { provider: "bogus" }));
    expect(response.status).toBe(400);
  });

  it("deletes the credential and returns 200 { status: 'deleted' }", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockGetServiceRoleClient.mockReturnValue({});
    mockCheckAICredentialsRateLimit.mockReturnValue(ALLOWED_RATE_LIMIT);
    mockDeleteAIProviderCredential.mockResolvedValue(undefined);

    const response = await DELETE(makeRequest("DELETE", { provider: "gemini" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "deleted" });
    expect(mockDeleteAIProviderCredential).toHaveBeenCalledWith({}, "user-1", "gemini");
  });
});
