// app/api/projects/__tests__/route.test.ts
//
// Unit test for GET/POST /api/projects: exercises each handler's own
// control flow (auth -> body validation (POST only) -> the right
// projects-table query -> ProjectDTO mapping, including the
// `documents(count)` embed -> response shape) against a mocked Supabase
// client, mirroring app/api/sources/[documentId]/__tests__/route.test.ts's
// style. There is no ownership check in this file's own two endpoints (GET
// is filtered to the caller's own rows by construction, POST creates a
// brand new row owned by the caller) -- ownership enforcement is covered
// by ./[projectId]/__tests__/route.test.ts and the sibling
// model/channels-telegram test files, which DO take an existing
// `projectId` from an untrusted caller.

import { afterEach, describe, expect, it, vi } from "vitest";

const mockGetRouteHandlerSupabaseClient = vi.fn();
const mockGetAuthenticatedUser = vi.fn();
const mockGetServiceRoleClient = vi.fn();

vi.mock("@/lib/supabase/server-client", () => ({
  getRouteHandlerSupabaseClient: () => mockGetRouteHandlerSupabaseClient(),
  getAuthenticatedUser: (client: unknown) => mockGetAuthenticatedUser(client),
}));

vi.mock("@/lib/supabase/service-client", () => ({
  getServiceRoleClient: () => mockGetServiceRoleClient(),
}));

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

describe("GET /api/projects", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 401 { error: 'unauthorized' } when there is no session, without touching the DB", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(mockGetServiceRoleClient).not.toHaveBeenCalled();
  });

  it("returns 200 with each project mapped to a ProjectDTO, extracting documentCount from the documents(count) embed", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    const stub = makeListStub({
      data: [
        {
          id: "project-1",
          name: "бот1",
          active_ai_provider: "openai",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
          documents: [{ count: 5 }],
        },
        {
          id: "project-2",
          name: "бот2",
          active_ai_provider: null,
          created_at: "2026-01-03T00:00:00Z",
          updated_at: "2026-01-03T00:00:00Z",
          documents: [{ count: 0 }],
        },
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
          activeAiProvider: "openai",
          documentCount: 5,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
        },
        {
          id: "project-2",
          name: "бот2",
          activeAiProvider: null,
          documentCount: 0,
          createdAt: "2026-01-03T00:00:00Z",
          updatedAt: "2026-01-03T00:00:00Z",
        },
      ],
    });
    // Scoped to the caller's own rows via an explicit filter, not trusted
    // to RLS on this service-role client -- see route.ts's own header.
    expect(stub.__spies.eq).toHaveBeenCalledWith("user_id", "user-1");
  });

  it("returns 200 { projects: [] } for a user with no projects yet (not an error)", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockGetServiceRoleClient.mockReturnValue(makeListStub({ data: [], error: null }));

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projects: [] });
  });

  it("returns 500 when the DB query fails", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockGetServiceRoleClient.mockReturnValue(makeListStub({ data: null, error: { message: "db is down" } }));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET();

    expect(response.status).toBe(500);
    consoleErrorSpy.mockRestore();
  });
});

describe("POST /api/projects", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 401 when there is no session, without touching the DB", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue(null);

    const response = await POST(makeRequest("POST", { name: "бот1" }));

    expect(response.status).toBe(401);
    expect(mockGetServiceRoleClient).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });

    const badRequest = new Request("http://localhost/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const response = await POST(badRequest);
    expect(response.status).toBe(400);
  });

  it("returns 400 for an empty/whitespace-only name", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });

    const response = await POST(makeRequest("POST", { name: "   " }));
    expect(response.status).toBe(400);
    expect(mockGetServiceRoleClient).not.toHaveBeenCalled();
  });

  it("returns 400 for a name over 200 characters", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });

    const response = await POST(makeRequest("POST", { name: "x".repeat(201) }));
    expect(response.status).toBe(400);
  });

  it("creates the project for the authenticated user and returns 201 { project }", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    const stub = makeCreateStub({
      data: {
        id: "project-new",
        name: "бот1",
        active_ai_provider: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        documents: [{ count: 0 }],
      },
      error: null,
    });
    mockGetServiceRoleClient.mockReturnValue(stub);

    const response = await POST(makeRequest("POST", { name: "  бот1  " }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      project: {
        id: "project-new",
        name: "бот1",
        activeAiProvider: null,
        documentCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    // Trimmed before being sent to the DB, and always inserted under the
    // AUTHENTICATED caller's own id -- never anything from the body.
    expect(stub.__spies.insert).toHaveBeenCalledWith({ user_id: "user-1", name: "бот1" });
  });

  it("returns 500 when the insert fails", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockGetServiceRoleClient.mockReturnValue(makeCreateStub({ data: null, error: { message: "db is down" } }));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(makeRequest("POST", { name: "бот1" }));

    expect(response.status).toBe(500);
    consoleErrorSpy.mockRestore();
  });
});
