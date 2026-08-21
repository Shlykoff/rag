// app/api/projects/[projectId]/model/__tests__/route.test.ts
//
// Unit test for GET/PUT /api/projects/{projectId}/model: exercises the
// route's own control flow (auth -> project-ownership check, 404 not 403
// on mismatch -> the right lib/ai/ calls -> MissingProviderCredentialsError
// mapped to a clean 400, never a 500 -> response shape) against a mocked
// lib/ai. lib/ai's real MissingProviderCredentialsError class is kept
// (via importOriginal) so `err instanceof MissingProviderCredentialsError`
// inside route.ts still works against the mocked setActiveProvider's
// rejection -- only the functions this route actually calls are replaced.

import { afterEach, describe, expect, it, vi } from "vitest";

const mockGetRouteHandlerSupabaseClient = vi.fn();
const mockGetAuthenticatedUser = vi.fn();
const mockVerifyProjectOwnership = vi.fn();
const mockGetServiceRoleClient = vi.fn();
const mockGetActiveProvider = vi.fn();
const mockSetActiveProvider = vi.fn();
const mockHasAIProviderCredential = vi.fn();

vi.mock("@/lib/supabase/server-client", () => ({
  getRouteHandlerSupabaseClient: () => mockGetRouteHandlerSupabaseClient(),
  getAuthenticatedUser: (client: unknown) => mockGetAuthenticatedUser(client),
  verifyProjectOwnership: (...args: unknown[]) => mockVerifyProjectOwnership(...args),
}));

vi.mock("@/lib/supabase/service-client", () => ({
  getServiceRoleClient: () => mockGetServiceRoleClient(),
}));

vi.mock("@/lib/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai")>();
  return {
    ...actual,
    getActiveProvider: (...args: unknown[]) => mockGetActiveProvider(...args),
    setActiveProvider: (...args: unknown[]) => mockSetActiveProvider(...args),
    hasAIProviderCredential: (...args: unknown[]) => mockHasAIProviderCredential(...args),
  };
});

import { GET, PUT } from "../route";
import { MissingProviderCredentialsError } from "@/lib/ai";

function makeRequest(method: string, body?: unknown): Request {
  return new Request("http://localhost/api/projects/project-1/model", {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function makeParams(projectId: string): { params: Promise<{ projectId: string }> } {
  return { params: Promise.resolve({ projectId }) };
}

describe("GET /api/projects/{projectId}/model", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 401 when there is no session, without checking ownership", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue(null);

    const response = await GET(makeRequest("GET"), makeParams("project-1"));

    expect(response.status).toBe(401);
    expect(mockVerifyProjectOwnership).not.toHaveBeenCalled();
  });

  it("returns 404 (not 403) when the project belongs to another user, without touching lib/ai", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-2", email: "b@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(false);

    const response = await GET(makeRequest("GET"), makeParams("project-1"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(mockGetActiveProvider).not.toHaveBeenCalled();
  });

  it("returns 200 { activeProvider, configured } for the owner", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockGetServiceRoleClient.mockReturnValue({});
    mockGetActiveProvider.mockResolvedValue("gemini");
    mockHasAIProviderCredential.mockImplementation(async (_s: unknown, _u: string, provider: string) => provider === "gemini");

    const response = await GET(makeRequest("GET"), makeParams("project-1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      activeProvider: "gemini",
      configured: { openai: false, anthropic: false, gemini: true, voyage: false },
    });
    expect(mockGetActiveProvider).toHaveBeenCalledWith({}, "project-1");
  });

  it("returns 200 { activeProvider: null, ... } for a project that hasn't picked a model yet", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockGetServiceRoleClient.mockReturnValue({});
    mockGetActiveProvider.mockResolvedValue(null);
    mockHasAIProviderCredential.mockResolvedValue(false);

    const response = await GET(makeRequest("GET"), makeParams("project-1"));

    expect(response.status).toBe(200);
    expect((await response.json()).activeProvider).toBeNull();
  });

  it("returns 500 when loading provider state throws", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockGetServiceRoleClient.mockReturnValue({});
    mockGetActiveProvider.mockRejectedValue(new Error("db is down"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(makeRequest("GET"), makeParams("project-1"));

    expect(response.status).toBe(500);
    consoleErrorSpy.mockRestore();
  });
});

describe("PUT /api/projects/{projectId}/model", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 401 when there is no session, without checking ownership", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue(null);

    const response = await PUT(makeRequest("PUT", { provider: "openai" }), makeParams("project-1"));

    expect(response.status).toBe(401);
    expect(mockVerifyProjectOwnership).not.toHaveBeenCalled();
  });

  it("returns 404 (not 403) when the project belongs to another user, without calling setActiveProvider", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-2", email: "b@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(false);

    const response = await PUT(makeRequest("PUT", { provider: "openai" }), makeParams("project-1"));

    expect(response.status).toBe(404);
    expect(mockSetActiveProvider).not.toHaveBeenCalled();
  });

  it("returns 400 for an unknown provider value", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);

    const response = await PUT(makeRequest("PUT", { provider: "not-a-real-provider" }), makeParams("project-1"));

    expect(response.status).toBe(400);
    expect(mockSetActiveProvider).not.toHaveBeenCalled();
  });

  it("returns 400 for 'voyage' specifically -- never independently activatable as a project's provider", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);

    const response = await PUT(makeRequest("PUT", { provider: "voyage" }), makeParams("project-1"));

    expect(response.status).toBe(400);
  });

  it("returns 400 for malformed JSON", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);

    const badRequest = new Request("http://localhost/api/projects/project-1/model", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const response = await PUT(badRequest, makeParams("project-1"));
    expect(response.status).toBe(400);
  });

  it("sets the active provider and returns 200 { activeProvider }", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockGetServiceRoleClient.mockReturnValue({});
    mockSetActiveProvider.mockResolvedValue(undefined);

    const response = await PUT(makeRequest("PUT", { provider: "gemini" }), makeParams("project-1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ activeProvider: "gemini" });
    expect(mockSetActiveProvider).toHaveBeenCalledWith({}, "project-1", "user-1", "gemini");
  });

  it("returns 400 { error: 'missing_credentials' } (not 500) when the owner hasn't connected that provider's credential yet, and doesn't log via console.error", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockGetServiceRoleClient.mockReturnValue({});
    mockSetActiveProvider.mockRejectedValue(new MissingProviderCredentialsError("anthropic", ["anthropic", "voyage"]));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await PUT(makeRequest("PUT", { provider: "anthropic" }), makeParams("project-1"));

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload).toMatchObject({ error: "missing_credentials", provider: "anthropic", missing: ["anthropic", "voyage"] });
    expect(typeof payload.message).toBe("string");
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("returns 500 for any other failure (e.g. a defense-in-depth project/owner mismatch), and DOES log via console.error", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockGetServiceRoleClient.mockReturnValue({});
    mockSetActiveProvider.mockRejectedValue(new Error("project-1 belongs to someone else"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await PUT(makeRequest("PUT", { provider: "openai" }), makeParams("project-1"));

    expect(response.status).toBe(500);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
