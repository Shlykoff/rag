// app/api/projects/__tests__/route.test.ts
//
// GET/POST /api/projects against a mocked Supabase client: auth -> body
// validation (POST) -> the projects query -> ProjectDTO mapping (document
// count and chat model come from embeds). POST pre-fills models via
// lib/ai's auto-fill rule, mocked here. No ownership check in these two
// endpoints: GET is filtered to the caller's rows, POST creates one owned
// by the caller.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureModel } from "@/lib/testing/ai-model-fixtures";

const mockGetRouteHandlerSupabaseClient = vi.fn();
const mockGetAuthenticatedUser = vi.fn();
const mockGetServiceRoleClient = vi.fn();
const mockResolveAutoFillModels = vi.fn();

vi.mock("@/lib/supabase/server-client", () => ({
  getRouteHandlerSupabaseClient: () => mockGetRouteHandlerSupabaseClient(),
  getAuthenticatedUser: (client: unknown) => mockGetAuthenticatedUser(client),
}));

vi.mock("@/lib/supabase/service-client", () => ({
  getServiceRoleClient: () => mockGetServiceRoleClient(),
}));

vi.mock("@/lib/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai")>();
  return { ...actual, resolveAutoFillModels: (...args: unknown[]) => mockResolveAutoFillModels(...args) };
});

import { GET, POST } from "../route";

function makeRequest(method: string, body?: unknown): Request {
  return new Request("http://localhost/api/projects", {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** Minimal fake of `.from("projects").select(cols).eq("user_id", id).order(...)`. */
function makeListStub(result: { data: unknown; error: unknown }) {
  const order = vi.fn().mockResolvedValue(result);
  const eq = vi.fn().mockReturnValue({ order });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn((table: string) => {
    if (table !== "projects") throw new Error(`unexpected table: ${table}`);
    return { select };
  });
  return { from, __spies: { select, eq, order } };
}

/** Minimal fake of `.from("projects").insert({...}).select(cols).single()`. */
function makeCreateStub(result: { data: unknown; error: unknown }) {
  const single = vi.fn().mockResolvedValue(result);
  const select = vi.fn().mockReturnValue({ single });
  const insert = vi.fn().mockReturnValue({ select });
  const from = vi.fn((table: string) => {
    if (table !== "projects") throw new Error(`unexpected table: ${table}`);
    return { insert };
  });
  return { from, __spies: { insert, select, single } };
}

function signedIn() {
  mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
  mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
}

const NEW_ROW = {
  id: "project-new",
  name: "бот1",
  chat_model_id: null,
  embedding_model_id: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  documents: [{ count: 0 }],
  chat_model: null,
};

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("GET /api/projects", () => {
  it("returns 401 { error: 'unauthorized' } when there is no session, without touching the DB", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(mockGetServiceRoleClient).not.toHaveBeenCalled();
  });

  it("maps each project to a ProjectDTO, with document count and chat model from the embeds", async () => {
    signedIn();
    const stub = makeListStub({
      data: [
        {
          id: "project-1",
          name: "бот1",
          chat_model_id: "chat-1",
          embedding_model_id: "emb-1",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
          documents: [{ count: 5 }],
          chat_model: { display_name: "Claude Opus 5", provider: "anthropic" },
        },
        { ...NEW_ROW, id: "project-2", name: "бот2" },
      ],
      error: null,
    });
    mockGetServiceRoleClient.mockReturnValue(stub);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      projects: [
        {
          id: "project-1",
          name: "бот1",
          activeAiProvider: "anthropic",
          chatModelId: "chat-1",
          chatModelName: "Claude Opus 5",
          embeddingModelId: "emb-1",
          documentCount: 5,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
        },
        {
          id: "project-2",
          name: "бот2",
          activeAiProvider: null,
          chatModelId: null,
          chatModelName: null,
          embeddingModelId: null,
          documentCount: 0,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    expect(stub.__spies.eq).toHaveBeenCalledWith("user_id", "user-1");
    expect(stub.__spies.select.mock.calls[0][0]).toMatch(/chat_model:ai_models!projects_chat_model_fkey/);
  });

  it("returns 200 { projects: [] } for a user with no projects yet", async () => {
    signedIn();
    mockGetServiceRoleClient.mockReturnValue(makeListStub({ data: [], error: null }));

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projects: [] });
  });

  it("returns 500 when the DB query fails", async () => {
    signedIn();
    mockGetServiceRoleClient.mockReturnValue(makeListStub({ data: null, error: { message: "db is down" } }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect((await GET()).status).toBe(500);
  });
});

describe("POST /api/projects", () => {
  it("returns 401 when there is no session, without touching the DB", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue(null);

    const response = await POST(makeRequest("POST", { name: "бот1" }));

    expect(response.status).toBe(401);
    expect(mockGetServiceRoleClient).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON", async () => {
    signedIn();
    const badRequest = new Request("http://localhost/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect((await POST(badRequest)).status).toBe(400);
  });

  it("returns 400 for an empty/whitespace-only name", async () => {
    signedIn();
    expect((await POST(makeRequest("POST", { name: "   " }))).status).toBe(400);
    expect(mockGetServiceRoleClient).not.toHaveBeenCalled();
  });

  it("returns 400 for a name over 200 characters", async () => {
    signedIn();
    expect((await POST(makeRequest("POST", { name: "x".repeat(201) }))).status).toBe(400);
  });

  it("creates the project with no models when the keys leave no unambiguous choice", async () => {
    signedIn();
    const stub = makeCreateStub({ data: NEW_ROW, error: null });
    mockGetServiceRoleClient.mockReturnValue(stub);
    mockResolveAutoFillModels.mockResolvedValue({ chat: null, embedding: null });

    const response = await POST(makeRequest("POST", { name: "  бот1  " }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      project: {
        id: "project-new",
        name: "бот1",
        activeAiProvider: null,
        chatModelId: null,
        chatModelName: null,
        embeddingModelId: null,
        documentCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    // Trimmed, and always under the authenticated caller's own id.
    expect(stub.__spies.insert).toHaveBeenCalledWith({ user_id: "user-1", name: "бот1" });
    expect(mockResolveAutoFillModels).toHaveBeenCalledWith(stub, "user-1");
  });

  it("inserts the auto-filled models together with their provider columns", async () => {
    signedIn();
    const stub = makeCreateStub({ data: NEW_ROW, error: null });
    mockGetServiceRoleClient.mockReturnValue(stub);
    const chat = fixtureModel("gpt-5.6-luna");
    const embedding = fixtureModel("text-embedding-3-small");
    mockResolveAutoFillModels.mockResolvedValue({ chat, embedding });

    await POST(makeRequest("POST", { name: "бот1" }));

    expect(stub.__spies.insert).toHaveBeenCalledWith({
      user_id: "user-1",
      name: "бот1",
      chat_model_id: chat.id,
      active_ai_provider: "openai",
      embedding_model_id: embedding.id,
      embedding_provider: "openai",
    });
  });

  it("still creates the project when resolving default models fails", async () => {
    signedIn();
    const stub = makeCreateStub({ data: NEW_ROW, error: null });
    mockGetServiceRoleClient.mockReturnValue(stub);
    mockResolveAutoFillModels.mockRejectedValue(new Error("catalog down"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(makeRequest("POST", { name: "бот1" }));

    expect(response.status).toBe(201);
    expect(stub.__spies.insert).toHaveBeenCalledWith({ user_id: "user-1", name: "бот1" });
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("returns 500 when the insert fails", async () => {
    signedIn();
    mockGetServiceRoleClient.mockReturnValue(makeCreateStub({ data: null, error: { message: "db is down" } }));
    mockResolveAutoFillModels.mockResolvedValue({ chat: null, embedding: null });
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect((await POST(makeRequest("POST", { name: "бот1" }))).status).toBe(500);
  });
});
