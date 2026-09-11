// app/api/projects/[projectId]/model/__tests__/route.test.ts
//
// GET/PUT /api/projects/{projectId}/model against a mocked lib/ai. The real
// error classes are kept (importOriginal) so the route's `instanceof`
// checks work against the mocked functions' rejections.

import { afterEach, describe, expect, it, vi } from "vitest";
import { aiModel, FIXTURE_CATALOG, fixtureModel } from "@/lib/testing/ai-model-fixtures";

const mockGetRouteHandlerSupabaseClient = vi.fn();
const mockGetAuthenticatedUser = vi.fn();
const mockVerifyProjectOwnership = vi.fn();
const mockGetServiceRoleClient = vi.fn();
const mockGetConfiguredProvidersMap = vi.fn();
const mockListAIModels = vi.fn();
const mockAutoFillProjectModels = vi.fn();
const mockGetProjectModelState = vi.fn();
const mockSetProjectChatModel = vi.fn();
const mockSetProjectEmbeddingModel = vi.fn();

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
    getConfiguredProvidersMap: (...args: unknown[]) => mockGetConfiguredProvidersMap(...args),
    listAIModels: (...args: unknown[]) => mockListAIModels(...args),
    autoFillProjectModels: (...args: unknown[]) => mockAutoFillProjectModels(...args),
    getProjectModelState: (...args: unknown[]) => mockGetProjectModelState(...args),
    setProjectChatModel: (...args: unknown[]) => mockSetProjectChatModel(...args),
    setProjectEmbeddingModel: (...args: unknown[]) => mockSetProjectEmbeddingModel(...args),
  };
});

import { GET, PUT } from "../route";
import {
  EmbeddingModelLockedError,
  InvalidModelSelectionError,
  MissingProviderCredentialsError,
  type AIModelKind,
  type InvalidModelReason,
} from "@/lib/ai";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const MODEL_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_CLIENT = { service: true };
const CONFIGURED = { openai: true, anthropic: false, gemini: false, voyage: false };

const RETIRED_SELECTED = aiModel({ provider: "openai", modelId: "gpt-retired", kind: "chat", isActive: false, sortOrder: 5 });
const RETIRED_UNSELECTED = aiModel({ provider: "openai", modelId: "gpt-gone", kind: "chat", isActive: false, sortOrder: 6 });
const CATALOG = [RETIRED_SELECTED, RETIRED_UNSELECTED, ...FIXTURE_CATALOG];

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
  mockGetServiceRoleClient.mockReturnValue(SERVICE_CLIENT);
}

function signedInStranger() {
  mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
  mockGetAuthenticatedUser.mockResolvedValue({ id: "user-2", email: "b@b.com" });
  mockVerifyProjectOwnership.mockResolvedValue(false);
}

function silenceConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("uuid shape guard", () => {
  it("GET and PUT return 404 for a malformed projectId without touching auth", async () => {
    expect((await GET(makeRequest("GET"), makeParams("not-a-uuid"))).status).toBe(404);
    expect((await PUT(makeRequest("PUT", { chatModelId: MODEL_ID }), makeParams("not-a-uuid"))).status).toBe(404);
    expect(mockGetRouteHandlerSupabaseClient).not.toHaveBeenCalled();
  });
});

describe("GET /api/projects/{projectId}/model", () => {
  it("401 without a session, without checking ownership", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue(null);

    expect((await GET(makeRequest("GET"), makeParams(PROJECT_ID))).status).toBe(401);
    expect(mockVerifyProjectOwnership).not.toHaveBeenCalled();
  });

  it("404 (not 403) for another user's project, without touching lib/ai", async () => {
    signedInStranger();

    expect((await GET(makeRequest("GET"), makeParams(PROJECT_ID))).status).toBe(404);
    expect(mockListAIModels).not.toHaveBeenCalled();
    expect(mockAutoFillProjectModels).not.toHaveBeenCalled();
  });

  it("auto-fills first, then returns the state, keys and catalog (active rows + the selected retired one)", async () => {
    signedInOwner();
    mockGetConfiguredProvidersMap.mockResolvedValue(CONFIGURED);
    mockListAIModels.mockResolvedValue(CATALOG);
    mockAutoFillProjectModels.mockResolvedValue({ chat: null, embedding: null });
    const state = {
      chatModelId: RETIRED_SELECTED.id,
      embeddingModelId: fixtureModel("text-embedding-3-small").id,
      embeddingLocked: true,
    };
    mockGetProjectModelState.mockResolvedValue(state);

    const response = await GET(makeRequest("GET"), makeParams(PROJECT_ID));

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({ ...state, configured: CONFIGURED });
    expect(payload.models.map((m: { modelId: string }) => m.modelId)).toEqual([
      "gpt-retired",
      ...FIXTURE_CATALOG.map((m) => m.modelId),
    ]);
    const luna = fixtureModel("gpt-5.6-luna");
    expect(payload.models.find((m: { id: string }) => m.id === luna.id)).toEqual({
      id: luna.id,
      provider: luna.provider,
      modelId: luna.modelId,
      kind: luna.kind,
      displayName: luna.displayName,
      dimensions: luna.dimensions,
      contextWindow: luna.contextWindow,
      maxOutputTokens: luna.maxOutputTokens,
      inputPriceUsdPerMtok: luna.inputPriceUsdPerMtok,
      outputPriceUsdPerMtok: luna.outputPriceUsdPerMtok,
      pricingAsOf: luna.pricingAsOf,
      isRecommended: luna.isRecommended,
      isActive: luna.isActive,
    });

    expect(mockAutoFillProjectModels).toHaveBeenCalledWith(SERVICE_CLIENT, "user-1", {
      projectId: PROJECT_ID,
      configured: CONFIGURED,
      catalog: CATALOG,
    });
    expect(mockAutoFillProjectModels.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetProjectModelState.mock.invocationCallOrder[0]
    );
  });

  it("still returns 200 when auto-fill fails, logging it", async () => {
    signedInOwner();
    mockGetConfiguredProvidersMap.mockResolvedValue(CONFIGURED);
    mockListAIModels.mockResolvedValue(FIXTURE_CATALOG);
    mockAutoFillProjectModels.mockRejectedValue(new Error("db hiccup"));
    mockGetProjectModelState.mockResolvedValue({ chatModelId: null, embeddingModelId: null, embeddingLocked: false });
    const consoleErrorSpy = silenceConsoleError();

    const response = await GET(makeRequest("GET"), makeParams(PROJECT_ID));

    expect(response.status).toBe(200);
    expect((await response.json()).models).toHaveLength(FIXTURE_CATALOG.length);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("500 when loading the catalog fails", async () => {
    signedInOwner();
    mockGetConfiguredProvidersMap.mockResolvedValue(CONFIGURED);
    mockListAIModels.mockRejectedValue(new Error("db is down"));
    silenceConsoleError();

    const response = await GET(makeRequest("GET"), makeParams(PROJECT_ID));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "internal_error" });
  });
});

describe("PUT /api/projects/{projectId}/model", () => {
  it("401 without a session", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue(null);

    expect((await PUT(makeRequest("PUT", { chatModelId: MODEL_ID }), makeParams(PROJECT_ID))).status).toBe(401);
  });

  it("404 for another user's project, changing nothing", async () => {
    signedInStranger();

    expect((await PUT(makeRequest("PUT", { chatModelId: MODEL_ID }), makeParams(PROJECT_ID))).status).toBe(404);
    expect(mockSetProjectChatModel).not.toHaveBeenCalled();
  });

  it.each([
    ["the old provider field", { provider: "openai" }],
    ["both fields at once", { chatModelId: MODEL_ID, embeddingModelId: MODEL_ID }],
    ["neither field", {}],
    ["a non-uuid id", { chatModelId: "gpt-5.6-luna" }],
    ["an extra field", { chatModelId: MODEL_ID, extra: true }],
  ])("400 invalid_request for %s", async (_label, body) => {
    signedInOwner();

    const response = await PUT(makeRequest("PUT", body), makeParams(PROJECT_ID));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_request");
    expect(mockSetProjectChatModel).not.toHaveBeenCalled();
    expect(mockSetProjectEmbeddingModel).not.toHaveBeenCalled();
  });

  it("sets the chat model and returns 200 { chatModelId }", async () => {
    signedInOwner();
    mockSetProjectChatModel.mockResolvedValue({ ...fixtureModel("gpt-5.6-luna"), id: MODEL_ID });

    const response = await PUT(makeRequest("PUT", { chatModelId: MODEL_ID }), makeParams(PROJECT_ID));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ chatModelId: MODEL_ID });
    expect(mockSetProjectChatModel).toHaveBeenCalledWith(SERVICE_CLIENT, PROJECT_ID, "user-1", MODEL_ID);
  });

  it("sets the embedding model and returns 200 { embeddingModelId }", async () => {
    signedInOwner();
    mockSetProjectEmbeddingModel.mockResolvedValue({ ...fixtureModel("voyage-4-large"), id: MODEL_ID });

    const response = await PUT(makeRequest("PUT", { embeddingModelId: MODEL_ID }), makeParams(PROJECT_ID));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ embeddingModelId: MODEL_ID });
    expect(mockSetProjectChatModel).not.toHaveBeenCalled();
  });

  it.each<[InvalidModelReason, AIModelKind, "chatModelId" | "embeddingModelId"]>([
    ["not_found", "chat", "chatModelId"],
    ["wrong_kind", "embedding", "embeddingModelId"],
    ["inactive", "chat", "chatModelId"],
  ])("400 invalid_model (%s) with a message, not logged", async (reason, slot, field) => {
    signedInOwner();
    const error = new InvalidModelSelectionError(slot, MODEL_ID, reason);
    mockSetProjectChatModel.mockRejectedValue(error);
    mockSetProjectEmbeddingModel.mockRejectedValue(error);
    const consoleErrorSpy = silenceConsoleError();

    const response = await PUT(makeRequest("PUT", { [field]: MODEL_ID }), makeParams(PROJECT_ID));

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload).toMatchObject({ error: "invalid_model", reason });
    expect(typeof payload.message).toBe("string");
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("422 missing_credentials naming the provider, not logged", async () => {
    signedInOwner();
    mockSetProjectChatModel.mockRejectedValue(new MissingProviderCredentialsError("anthropic"));
    const consoleErrorSpy = silenceConsoleError();

    const response = await PUT(makeRequest("PUT", { chatModelId: MODEL_ID }), makeParams(PROJECT_ID));

    expect(response.status).toBe(422);
    const payload = await response.json();
    expect(payload).toMatchObject({ error: "missing_credentials", provider: "anthropic" });
    expect(payload.message).toMatch(/Anthropic/);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("409 embedding_locked, not logged", async () => {
    signedInOwner();
    mockSetProjectEmbeddingModel.mockRejectedValue(new EmbeddingModelLockedError(PROJECT_ID));
    const consoleErrorSpy = silenceConsoleError();

    const response = await PUT(makeRequest("PUT", { embeddingModelId: MODEL_ID }), makeParams(PROJECT_ID));

    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("embedding_locked");
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("500 for any other failure, logged and without leaking the error", async () => {
    signedInOwner();
    mockSetProjectChatModel.mockRejectedValue(new Error(`${PROJECT_ID} belongs to someone else`));
    const consoleErrorSpy = silenceConsoleError();

    const response = await PUT(makeRequest("PUT", { chatModelId: MODEL_ID }), makeParams(PROJECT_ID));

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toMatch(/belongs to/);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
