// app/api/projects/[projectId]/model/__tests__/route.test.ts
//
// Unit test for GET/PUT /api/projects/{projectId}/model against a mocked
// lib/ai. The real error classes are kept (via importOriginal) so the
// route's `instanceof` checks work against the mocked functions' rejections.

import { afterEach, describe, expect, it, vi } from "vitest";

const mockGetRouteHandlerSupabaseClient = vi.fn();
const mockGetAuthenticatedUser = vi.fn();
const mockVerifyProjectOwnership = vi.fn();
const mockGetServiceRoleClient = vi.fn();
const mockGetActiveProvider = vi.fn();
const mockSetActiveProvider = vi.fn();
const mockGetProjectEmbeddingState = vi.fn();
const mockSetProjectEmbeddingProvider = vi.fn();
const mockGetConfiguredProvidersMap = vi.fn();

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
    getProjectEmbeddingState: (...args: unknown[]) => mockGetProjectEmbeddingState(...args),
    setProjectEmbeddingProvider: (...args: unknown[]) => mockSetProjectEmbeddingProvider(...args),
    getConfiguredProvidersMap: (...args: unknown[]) => mockGetConfiguredProvidersMap(...args),
  };
});

import { GET, PUT } from "../route";
import { EmbeddingProviderLockedError, MissingProviderCredentialsError } from "@/lib/ai";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function makeRequest(method: string, body?: unknown): Request {
  return new Request(`http://localhost/api/projects/${PROJECT_ID}/model`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function makeParams(projectId: string): { params: Promise<{ projectId: string }> } {
  return { params: Promise.resolve({ projectId }) };
}

function signedInOwner() {
  mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
  mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
  mockVerifyProjectOwnership.mockResolvedValue(true);
  mockGetServiceRoleClient.mockReturnValue({});
}

describe("uuid shape guard (GET/PUT)", () => {
  afterEach(() => vi.clearAllMocks());

  it("GET returns 404 (not 500) for a syntactically invalid projectId, without touching auth", async () => {
    const response = await GET(makeRequest("GET"), makeParams("not-a-uuid"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(mockGetRouteHandlerSupabaseClient).not.toHaveBeenCalled();
  });

  it("PUT returns 404 (not 500) for a syntactically invalid projectId, without touching auth", async () => {
    const response = await PUT(makeRequest("PUT", { provider: "openai" }), makeParams("not-a-uuid"));
    expect(response.status).toBe(404);
    expect(mockGetRouteHandlerSupabaseClient).not.toHaveBeenCalled();
  });
});

describe("GET /api/projects/{projectId}/model", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 401 when there is no session, without checking ownership", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue(null);

    const response = await GET(makeRequest("GET"), makeParams(PROJECT_ID));

    expect(response.status).toBe(401);
    expect(mockVerifyProjectOwnership).not.toHaveBeenCalled();
  });

  it("returns 404 (not 403) when the project belongs to another user, without touching lib/ai", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-2", email: "b@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(false);

    const response = await GET(makeRequest("GET"), makeParams(PROJECT_ID));

    expect(response.status).toBe(404);
    expect(mockGetActiveProvider).not.toHaveBeenCalled();
  });

  it("returns both models, the embedding lock and the account's configured keys", async () => {
    signedInOwner();
    mockGetActiveProvider.mockResolvedValue("anthropic");
    mockGetProjectEmbeddingState.mockResolvedValue({ provider: "gemini", locked: true });
    mockGetConfiguredProvidersMap.mockResolvedValue({ openai: false, anthropic: true, gemini: true, voyage: false });

    const response = await GET(makeRequest("GET"), makeParams(PROJECT_ID));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      activeProvider: "anthropic",
      embeddingProvider: "gemini",
      embeddingLocked: true,
      configured: { openai: false, anthropic: true, gemini: true, voyage: false },
    });
  });

  it("returns nulls for a project that hasn't picked any model yet", async () => {
    signedInOwner();
    mockGetActiveProvider.mockResolvedValue(null);
    mockGetProjectEmbeddingState.mockResolvedValue({ provider: null, locked: false });
    mockGetConfiguredProvidersMap.mockResolvedValue({ openai: false, anthropic: false, gemini: false, voyage: false });

    const payload = await (await GET(makeRequest("GET"), makeParams(PROJECT_ID))).json();

    expect(payload).toMatchObject({ activeProvider: null, embeddingProvider: null, embeddingLocked: false });
  });

  it("returns 500 when loading provider state throws", async () => {
    signedInOwner();
    mockGetActiveProvider.mockRejectedValue(new Error("db is down"));
    mockGetProjectEmbeddingState.mockResolvedValue({ provider: null, locked: false });
    mockGetConfiguredProvidersMap.mockResolvedValue({});
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(makeRequest("GET"), makeParams(PROJECT_ID));

    expect(response.status).toBe(500);
    consoleErrorSpy.mockRestore();
  });
});

describe("PUT /api/projects/{projectId}/model", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 401 when there is no session, without checking ownership", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue(null);

    const response = await PUT(makeRequest("PUT", { provider: "openai" }), makeParams(PROJECT_ID));

    expect(response.status).toBe(401);
    expect(mockVerifyProjectOwnership).not.toHaveBeenCalled();
  });

  it("returns 404 (not 403) when the project belongs to another user, without changing anything", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-2", email: "b@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(false);

    const response = await PUT(makeRequest("PUT", { provider: "openai" }), makeParams(PROJECT_ID));

    expect(response.status).toBe(404);
    expect(mockSetActiveProvider).not.toHaveBeenCalled();
    expect(mockSetProjectEmbeddingProvider).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown chat provider", { provider: "not-a-real-provider" }],
    ["voyage as a chat provider", { provider: "voyage" }],
    ["anthropic as an embedding provider", { embeddingProvider: "anthropic" }],
    ["both fields at once", { provider: "openai", embeddingProvider: "openai" }],
    ["neither field", {}],
  ])("returns 400 for %s", async (_label, body) => {
    signedInOwner();

    const response = await PUT(makeRequest("PUT", body), makeParams(PROJECT_ID));

    expect(response.status).toBe(400);
    expect(mockSetActiveProvider).not.toHaveBeenCalled();
    expect(mockSetProjectEmbeddingProvider).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON", async () => {
    signedInOwner();
    const badRequest = new Request(`http://localhost/api/projects/${PROJECT_ID}/model`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    const response = await PUT(badRequest, makeParams(PROJECT_ID));

    expect(response.status).toBe(400);
  });

  it("sets the chat model and returns 200 { activeProvider }", async () => {
    signedInOwner();
    mockSetActiveProvider.mockResolvedValue(undefined);

    const response = await PUT(makeRequest("PUT", { provider: "gemini" }), makeParams(PROJECT_ID));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ activeProvider: "gemini" });
    expect(mockSetActiveProvider).toHaveBeenCalledWith({}, PROJECT_ID, "user-1", "gemini");
  });

  it("sets the embedding model and returns 200 { embeddingProvider }", async () => {
    signedInOwner();
    mockSetProjectEmbeddingProvider.mockResolvedValue(undefined);

    const response = await PUT(makeRequest("PUT", { embeddingProvider: "voyage" }), makeParams(PROJECT_ID));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ embeddingProvider: "voyage" });
    expect(mockSetProjectEmbeddingProvider).toHaveBeenCalledWith({}, PROJECT_ID, "user-1", "voyage");
    expect(mockSetActiveProvider).not.toHaveBeenCalled();
  });

  it("returns 400 { error: 'missing_credentials' } (not 500) when the owner hasn't connected that key, without console.error", async () => {
    signedInOwner();
    mockSetActiveProvider.mockRejectedValue(new MissingProviderCredentialsError("anthropic", ["anthropic"]));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await PUT(makeRequest("PUT", { provider: "anthropic" }), makeParams(PROJECT_ID));

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload).toMatchObject({ error: "missing_credentials", provider: "anthropic", missing: ["anthropic"] });
    expect(typeof payload.message).toBe("string");
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("returns 409 { error: 'embedding_locked' } when the project already has documents, without console.error", async () => {
    signedInOwner();
    mockSetProjectEmbeddingProvider.mockRejectedValue(new EmbeddingProviderLockedError(PROJECT_ID));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await PUT(makeRequest("PUT", { embeddingProvider: "openai" }), makeParams(PROJECT_ID));

    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.error).toBe("embedding_locked");
    expect(typeof payload.message).toBe("string");
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("returns 500 for any other failure, and logs it", async () => {
    signedInOwner();
    mockSetActiveProvider.mockRejectedValue(new Error(`${PROJECT_ID} belongs to someone else`));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await PUT(makeRequest("PUT", { provider: "openai" }), makeParams(PROJECT_ID));

    expect(response.status).toBe(500);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
