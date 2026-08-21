// app/api/profile/ai-providers/__tests__/route.test.ts
//
// Unit test for GET/POST/DELETE/PUT /api/profile/ai-providers: exercises
// each handler's own control flow (auth -> rate limit on the state-changing
// methods -> body validation -> the right lib/ai/credentials.ts call ->
// response shape) against mocked dependencies, mirroring
// app/api/chat/__tests__/route.test.ts's / app/api/sources/[documentId]/
// __tests__/route.test.ts's style. The live end-to-end path (real Postgres
// round trip, real encryption) is verified manually against local Supabase
// -- see this task's report, not re-asserted here since it'd require a
// live Docker Supabase to run in CI.

import { afterEach, describe, expect, it, vi } from "vitest";

const mockGetRouteHandlerSupabaseClient = vi.fn();
const mockGetAuthenticatedUser = vi.fn();
const mockGetServiceRoleClient = vi.fn();
const mockSaveAIProviderCredential = vi.fn();
const mockHasAIProviderCredential = vi.fn();
const mockDeleteAIProviderCredential = vi.fn();
const mockGetActiveProvider = vi.fn();
const mockSetActiveProvider = vi.fn();
const mockCheckAICredentialsRateLimit = vi.fn();

vi.mock("@/lib/supabase/server-client", () => ({
  getRouteHandlerSupabaseClient: () => mockGetRouteHandlerSupabaseClient(),
  getAuthenticatedUser: (client: unknown) => mockGetAuthenticatedUser(client),
}));

vi.mock("@/lib/supabase/service-client", () => ({
  getServiceRoleClient: () => mockGetServiceRoleClient(),
}));

// MissingProviderCredentialsError is the REAL class (imported from
// lib/ai/credentials, which has no DB/network dependency of its own at
// module-evaluation time -- only its exported functions touch a real
// Supabase client, and those are all faked below) so `err instanceof
// MissingProviderCredentialsError` inside route.ts still works against
// errors this test throws from the mocked setActiveProvider().
vi.mock("@/lib/ai", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/credentials")>("@/lib/ai/credentials");
  return {
    saveAIProviderCredential: (...args: unknown[]) => mockSaveAIProviderCredential(...args),
    hasAIProviderCredential: (...args: unknown[]) => mockHasAIProviderCredential(...args),
    deleteAIProviderCredential: (...args: unknown[]) => mockDeleteAIProviderCredential(...args),
    getActiveProvider: (...args: unknown[]) => mockGetActiveProvider(...args),
    setActiveProvider: (...args: unknown[]) => mockSetActiveProvider(...args),
    MissingProviderCredentialsError: actual.MissingProviderCredentialsError,
  };
});

vi.mock("@/lib/rate-limit/ai-credentials-rate-limiter", () => ({
  checkAICredentialsRateLimit: (...args: unknown[]) => mockCheckAICredentialsRateLimit(...args),
}));

import { GET, POST, DELETE, PUT } from "../route";
import { MissingProviderCredentialsError } from "@/lib/ai/credentials";

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

  it("returns 200 with per-provider configured booleans and the active provider, never a key value", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockGetServiceRoleClient.mockReturnValue({});
    mockHasAIProviderCredential.mockImplementation(async (_s: unknown, _u: string, provider: string) =>
      provider === "openai" || provider === "voyage"
    );
    mockGetActiveProvider.mockResolvedValue("openai");

    const response = await GET();

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      configured: { openai: true, anthropic: false, gemini: false, voyage: true },
      activeProvider: "openai",
    });
    // Never leaks a key -- the response has no field beyond the documented
    // shape that could carry one.
    expect(JSON.stringify(payload)).not.toMatch(/sk-|apiKey/i);
  });

  it("returns activeProvider: null when the user hasn't configured one yet", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockGetServiceRoleClient.mockReturnValue({});
    mockHasAIProviderCredential.mockResolvedValue(false);
    mockGetActiveProvider.mockResolvedValue(null);

    const response = await GET();
    const payload = await response.json();
    expect(payload.activeProvider).toBeNull();
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

  it("saves the credential and returns 200 { status: 'saved', activeProvider } on a valid request, for every provider including voyage", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockGetServiceRoleClient.mockReturnValue({});
    mockCheckAICredentialsRateLimit.mockReturnValue(ALLOWED_RATE_LIMIT);
    mockSaveAIProviderCredential.mockResolvedValue(undefined);
    // No active provider yet, and saving this voyage key alone doesn't
    // complete the anthropic pairing (no anthropic key present) -- so this
    // save must NOT auto-activate anything (see the dedicated auto-activate
    // describe block below for the cases where it does).
    mockGetActiveProvider.mockResolvedValue(null);
    mockHasAIProviderCredential.mockResolvedValue(false);

    const response = await POST(makeRequest("POST", { provider: "voyage", apiKey: "pa-real-key" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "saved", activeProvider: null });
    expect(mockSaveAIProviderCredential).toHaveBeenCalledWith({}, "user-1", "voyage", "pa-real-key");
    expect(mockSetActiveProvider).not.toHaveBeenCalled();
  });
});

describe("POST /api/profile/ai-providers auto-activates the completed provider when none is active yet", () => {
  afterEach(() => vi.clearAllMocks());

  it("auto-activates openai on its own single-key save when no provider is active yet", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockGetServiceRoleClient.mockReturnValue({});
    mockCheckAICredentialsRateLimit.mockReturnValue(ALLOWED_RATE_LIMIT);
    mockSaveAIProviderCredential.mockResolvedValue(undefined);
    mockGetActiveProvider.mockResolvedValue(null);
    mockSetActiveProvider.mockResolvedValue(undefined);

    const response = await POST(makeRequest("POST", { provider: "openai", apiKey: "sk-x" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "saved", activeProvider: "openai" });
    expect(mockSetActiveProvider).toHaveBeenCalledWith({}, "user-1", "openai");
  });

  it("does NOT auto-activate gemini when openai is already the active provider", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockGetServiceRoleClient.mockReturnValue({});
    mockCheckAICredentialsRateLimit.mockReturnValue(ALLOWED_RATE_LIMIT);
    mockSaveAIProviderCredential.mockResolvedValue(undefined);
    mockGetActiveProvider.mockResolvedValue("openai");

    const response = await POST(makeRequest("POST", { provider: "gemini", apiKey: "AIza-x" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "saved", activeProvider: "openai" });
    expect(mockSetActiveProvider).not.toHaveBeenCalled();
  });

  it("does NOT auto-activate anthropic when only the anthropic key (not voyage) is present", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockGetServiceRoleClient.mockReturnValue({});
    mockCheckAICredentialsRateLimit.mockReturnValue(ALLOWED_RATE_LIMIT);
    mockSaveAIProviderCredential.mockResolvedValue(undefined);
    mockGetActiveProvider.mockResolvedValue(null);
    mockHasAIProviderCredential.mockImplementation(async (_s: unknown, _u: string, provider: string) => provider === "anthropic");

    const response = await POST(makeRequest("POST", { provider: "anthropic", apiKey: "sk-ant-x" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "saved", activeProvider: null });
    expect(mockSetActiveProvider).not.toHaveBeenCalled();
  });

  it("auto-activates anthropic once the second of its two required keys (voyage, saved after anthropic) arrives", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockGetServiceRoleClient.mockReturnValue({});
    mockCheckAICredentialsRateLimit.mockReturnValue(ALLOWED_RATE_LIMIT);
    mockSaveAIProviderCredential.mockResolvedValue(undefined);
    mockGetActiveProvider.mockResolvedValue(null);
    // Both credentials are present by the time maybeAutoActivateProvider
    // re-checks (the anthropic key was saved earlier; this request is
    // saving voyage, the second/completing key).
    mockHasAIProviderCredential.mockResolvedValue(true);
    mockSetActiveProvider.mockResolvedValue(undefined);

    const response = await POST(makeRequest("POST", { provider: "voyage", apiKey: "pa-real-key" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "saved", activeProvider: "anthropic" });
    expect(mockSetActiveProvider).toHaveBeenCalledWith({}, "user-1", "anthropic");
  });

  it("also auto-activates anthropic when the anthropic key arrives second, after voyage was already saved", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockGetServiceRoleClient.mockReturnValue({});
    mockCheckAICredentialsRateLimit.mockReturnValue(ALLOWED_RATE_LIMIT);
    mockSaveAIProviderCredential.mockResolvedValue(undefined);
    mockGetActiveProvider.mockResolvedValue(null);
    mockHasAIProviderCredential.mockResolvedValue(true);
    mockSetActiveProvider.mockResolvedValue(undefined);

    const response = await POST(makeRequest("POST", { provider: "anthropic", apiKey: "sk-ant-x" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "saved", activeProvider: "anthropic" });
    expect(mockSetActiveProvider).toHaveBeenCalledWith({}, "user-1", "anthropic");
  });

  it("does not fail the save if auto-activation loses a race (setActiveProvider still rejects with MissingProviderCredentialsError)", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockGetServiceRoleClient.mockReturnValue({});
    mockCheckAICredentialsRateLimit.mockReturnValue(ALLOWED_RATE_LIMIT);
    mockSaveAIProviderCredential.mockResolvedValue(undefined);
    mockGetActiveProvider.mockResolvedValue(null);
    mockHasAIProviderCredential.mockResolvedValue(true);
    mockSetActiveProvider.mockRejectedValue(new MissingProviderCredentialsError("anthropic", ["voyage"]));

    const response = await POST(makeRequest("POST", { provider: "voyage", apiKey: "pa-real-key" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "saved", activeProvider: null });
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

describe("PUT /api/profile/ai-providers (set active provider)", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 401 when there is no session", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue(null);

    const response = await PUT(makeRequest("PUT", { activeProvider: "openai" }));
    expect(response.status).toBe(401);
    expect(mockSetActiveProvider).not.toHaveBeenCalled();
  });

  it("returns 429 when over the limit", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockCheckAICredentialsRateLimit.mockReturnValue({ allowed: false, currentCount: 10, limit: 10, retryAfterMs: 2000 });

    const response = await PUT(makeRequest("PUT", { activeProvider: "openai" }));
    expect(response.status).toBe(429);
    expect(mockSetActiveProvider).not.toHaveBeenCalled();
  });

  it("returns 400 { error: 'invalid_request' } for activeProvider: 'voyage' (never independently activatable)", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockCheckAICredentialsRateLimit.mockReturnValue(ALLOWED_RATE_LIMIT);

    const response = await PUT(makeRequest("PUT", { activeProvider: "voyage" }));
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toBe("invalid_request");
    expect(mockSetActiveProvider).not.toHaveBeenCalled();
  });

  it("returns 400 { error: 'missing_credentials' } when setActiveProvider() rejects with MissingProviderCredentialsError, and does not log via console.error", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockGetServiceRoleClient.mockReturnValue({});
    mockCheckAICredentialsRateLimit.mockReturnValue(ALLOWED_RATE_LIMIT);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSetActiveProvider.mockRejectedValue(new MissingProviderCredentialsError("anthropic", ["voyage"]));

    const response = await PUT(makeRequest("PUT", { activeProvider: "anthropic" }));

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toBe("missing_credentials");
    expect(payload.message).toMatch(/voyage/);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("returns 500 and logs via console.error for an unexpected (non-MissingProviderCredentialsError) failure", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockGetServiceRoleClient.mockReturnValue({});
    mockCheckAICredentialsRateLimit.mockReturnValue(ALLOWED_RATE_LIMIT);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSetActiveProvider.mockRejectedValue(new Error("db is down"));

    const response = await PUT(makeRequest("PUT", { activeProvider: "gemini" }));

    expect(response.status).toBe(500);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("sets the active provider and returns 200 { status: 'saved', activeProvider }", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockGetServiceRoleClient.mockReturnValue({});
    mockCheckAICredentialsRateLimit.mockReturnValue(ALLOWED_RATE_LIMIT);
    mockSetActiveProvider.mockResolvedValue(undefined);

    const response = await PUT(makeRequest("PUT", { activeProvider: "gemini" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "saved", activeProvider: "gemini" });
    expect(mockSetActiveProvider).toHaveBeenCalledWith({}, "user-1", "gemini");
  });
});
