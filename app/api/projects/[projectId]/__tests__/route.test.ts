// app/api/projects/[projectId]/__tests__/route.test.ts
//
// Unit test for GET/PATCH/DELETE /api/projects/{projectId}: exercises each
// handler's own control flow (auth -> project-ownership check, 404 not 403
// on mismatch -> the right projects-table query/mutation -> DELETE's
// Storage list()+remove() sweep -> response shape) against a mocked
// Supabase client, mirroring
// app/api/sources/[documentId]/__tests__/route.test.ts's style.
//
// Ownership enforcement (a second user can't read/rename/delete another
// user's project) is asserted directly here via mockVerifyProjectOwnership
// -- the same mechanism every other project-scoped route in this codebase
// already uses and is already unit-tested for -- plus, per this task's own
// "at least one integration test hitting real Postgres" requirement,
// route.integration.test.ts exercises the same three operations against a
// REAL RLS-scoped session client and a real cross-user project.

import { afterEach, describe, expect, it, vi } from "vitest";

const mockGetRouteHandlerSupabaseClient = vi.fn();
const mockGetAuthenticatedUser = vi.fn();
const mockVerifyProjectOwnership = vi.fn();
const mockGetServiceRoleClient = vi.fn();

vi.mock("@/lib/supabase/server-client", () => ({
  getRouteHandlerSupabaseClient: () => mockGetRouteHandlerSupabaseClient(),
  getAuthenticatedUser: (client: unknown) => mockGetAuthenticatedUser(client),
  verifyProjectOwnership: (...args: unknown[]) => mockVerifyProjectOwnership(...args),
}));

vi.mock("@/lib/supabase/service-client", () => ({
  getServiceRoleClient: () => mockGetServiceRoleClient(),
}));

import { GET, PATCH, DELETE } from "../route";

function makeRequest(method: string, body?: unknown): Request {
  return new Request("http://localhost/api/projects/project-1", {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function makeParams(projectId: string): { params: Promise<{ projectId: string }> } {
  return { params: Promise.resolve({ projectId }) };
}

const SAMPLE_ROW = {
  id: "project-1",
  name: "бот1",
  active_ai_provider: "openai" as const,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  documents: [{ count: 2 }],
};

const SAMPLE_DTO = {
  id: "project-1",
  name: "бот1",
  activeAiProvider: "openai",
  documentCount: 2,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
};

/** Fake of `.from("projects").select(cols).eq("id", id).maybeSingle()`. */
function makeGetStub(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn((table: string) => {
    if (table !== "projects") throw new Error(`unexpected table: ${table}`);
    return { select };
  });
  return { from, __spies: { select, eq, maybeSingle } };
}

/** Fake of `.from("projects").update({name}).eq("id", id).select(cols).maybeSingle()`. */
function makePatchStub(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const select = vi.fn().mockReturnValue({ maybeSingle });
  const eq = vi.fn().mockReturnValue({ select });
  const update = vi.fn().mockReturnValue({ eq });
  const from = vi.fn((table: string) => {
    if (table !== "projects") throw new Error(`unexpected table: ${table}`);
    return { update };
  });
  return { from, __spies: { update, eq, select, maybeSingle } };
}

interface StorageListLevel {
  path: string;
  data: { id: string | null; name: string }[] | null;
  error: { message: string } | null;
}

/**
 * Fake of the DELETE route's full dependency surface: `.storage.from
 * ("documents").list(path, opts)` (called once per level -- top-level
 * "<projectId>/", then once per discovered pseudo-folder), `.remove(paths)`,
 * and `.from("projects").delete().eq("id", id).select("id")`.
 */
function makeDeleteStub(options: {
  listLevels: StorageListLevel[];
  removeError?: { message: string } | null;
  deletedRows?: { id: string }[];
  dbDeleteError?: { message: string } | null;
}) {
  const list = vi.fn((path: string) => {
    const level = options.listLevels.find((l) => l.path === path);
    if (!level) throw new Error(`unexpected storage.list() path: ${path}`);
    return Promise.resolve({ data: level.data, error: level.error });
  });
  const remove = vi.fn().mockResolvedValue({ error: options.removeError ?? null });

  const deleteSelect = vi
    .fn()
    .mockResolvedValue({ data: options.dbDeleteError ? null : (options.deletedRows ?? [{ id: "project-1" }]), error: options.dbDeleteError ?? null });
  const deleteEqId = vi.fn().mockReturnValue({ select: deleteSelect });
  const deleteFn = vi.fn().mockReturnValue({ eq: deleteEqId });

  const from = vi.fn((table: string) => {
    if (table !== "projects") throw new Error(`unexpected table: ${table}`);
    return { delete: deleteFn };
  });

  return {
    from,
    storage: { from: vi.fn().mockReturnValue({ list, remove }) },
    __spies: { list, remove, deleteFn, deleteEqId, deleteSelect },
  };
}

describe("GET /api/projects/{projectId}", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 401 when there is no session, without checking ownership", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue(null);

    const response = await GET(makeRequest("GET"), makeParams("project-1"));

    expect(response.status).toBe(401);
    expect(mockVerifyProjectOwnership).not.toHaveBeenCalled();
  });

  it("returns 404 (not 403) when the project belongs to another user, without touching the service-role client", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-2", email: "b@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(false);

    const response = await GET(makeRequest("GET"), makeParams("project-1"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(mockGetServiceRoleClient).not.toHaveBeenCalled();
  });

  it("returns 404 when the project doesn't exist", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(false);

    const response = await GET(makeRequest("GET"), makeParams("does-not-exist"));

    expect(response.status).toBe(404);
  });

  it("returns 200 { project } for the owner", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockGetServiceRoleClient.mockReturnValue(makeGetStub({ data: SAMPLE_ROW, error: null }));

    const response = await GET(makeRequest("GET"), makeParams("project-1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ project: SAMPLE_DTO });
  });
});

describe("PATCH /api/projects/{projectId}", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 401 when there is no session", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue(null);

    const response = await PATCH(makeRequest("PATCH", { name: "new name" }), makeParams("project-1"));

    expect(response.status).toBe(401);
    expect(mockVerifyProjectOwnership).not.toHaveBeenCalled();
  });

  it("returns 404 (not 403) when the project belongs to another user, without touching the service-role client", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-2", email: "b@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(false);

    const response = await PATCH(makeRequest("PATCH", { name: "hijacked" }), makeParams("project-1"));

    expect(response.status).toBe(404);
    expect(mockGetServiceRoleClient).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty name, without touching the DB", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);

    const response = await PATCH(makeRequest("PATCH", { name: "" }), makeParams("project-1"));

    expect(response.status).toBe(400);
    expect(mockGetServiceRoleClient).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);

    const badRequest = new Request("http://localhost/api/projects/project-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const response = await PATCH(badRequest, makeParams("project-1"));
    expect(response.status).toBe(400);
  });

  it("renames the project and returns 200 { project }", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    const stub = makePatchStub({ data: { ...SAMPLE_ROW, name: "новое имя" }, error: null });
    mockGetServiceRoleClient.mockReturnValue(stub);

    const response = await PATCH(makeRequest("PATCH", { name: "  новое имя  " }), makeParams("project-1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ project: { ...SAMPLE_DTO, name: "новое имя" } });
    expect(stub.__spies.update).toHaveBeenCalledWith({ name: "новое имя" });
  });

  it("returns 404 when the project was deleted concurrently (update matches nothing)", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockGetServiceRoleClient.mockReturnValue(makePatchStub({ data: null, error: null }));

    const response = await PATCH(makeRequest("PATCH", { name: "новое имя" }), makeParams("project-1"));

    expect(response.status).toBe(404);
  });
});

describe("DELETE /api/projects/{projectId}", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 401 when there is no session, without checking ownership", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue(null);

    const response = await DELETE(makeRequest("DELETE"), makeParams("project-1"));

    expect(response.status).toBe(401);
    expect(mockVerifyProjectOwnership).not.toHaveBeenCalled();
  });

  it("returns 404 (not 403) when the project belongs to another user, without touching Storage or the DB", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-2", email: "b@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(false);

    const response = await DELETE(makeRequest("DELETE"), makeParams("project-1"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(mockGetServiceRoleClient).not.toHaveBeenCalled();
  });

  it("walks the two-level Storage prefix, removes every discovered object, THEN deletes the project row, and returns 200", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    const stub = makeDeleteStub({
      listLevels: [
        {
          path: "project-1",
          data: [
            { id: null, name: "doc-a" }, // pseudo-folder -> descend
            { id: null, name: "doc-b" },
          ],
          error: null,
        },
        { path: "project-1/doc-a", data: [{ id: "obj-1", name: "content.txt" }], error: null },
        { path: "project-1/doc-b", data: [{ id: "obj-2", name: "original.pdf" }], error: null },
      ],
    });
    mockGetServiceRoleClient.mockReturnValue(stub);

    const callOrder: string[] = [];
    stub.__spies.remove.mockImplementation(async () => {
      callOrder.push("storage-remove");
      return { error: null };
    });
    stub.__spies.deleteFn.mockImplementation(() => {
      callOrder.push("db-delete");
      return { eq: vi.fn().mockReturnValue({ select: vi.fn().mockResolvedValue({ data: [{ id: "project-1" }], error: null }) }) };
    });

    const response = await DELETE(makeRequest("DELETE"), makeParams("project-1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projectId: "project-1", status: "deleted" });
    expect(stub.__spies.remove).toHaveBeenCalledWith(["project-1/doc-a/content.txt", "project-1/doc-b/original.pdf"]);
    // Storage cleanup happens BEFORE the DB delete -- see route.ts's own
    // ordering comment (the opposite order from the single-document
    // delete route, deliberately).
    expect(callOrder).toEqual(["storage-remove", "db-delete"]);
  });

  it("skips the remove() call entirely when the project has no Storage objects at all", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    const stub = makeDeleteStub({ listLevels: [{ path: "project-1", data: [], error: null }] });
    mockGetServiceRoleClient.mockReturnValue(stub);

    const response = await DELETE(makeRequest("DELETE"), makeParams("project-1"));

    expect(response.status).toBe(200);
    expect(stub.__spies.remove).not.toHaveBeenCalled();
  });

  it("returns 500 { error: 'storage_cleanup_failed' } and does NOT delete the project row when the top-level list() fails", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    const stub = makeDeleteStub({ listLevels: [{ path: "project-1", data: null, error: { message: "storage is down" } }] });
    mockGetServiceRoleClient.mockReturnValue(stub);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await DELETE(makeRequest("DELETE"), makeParams("project-1"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "storage_cleanup_failed",
      message: "Не удалось очистить хранилище проекта. Попробуйте ещё раз.",
    });
    expect(stub.__spies.deleteFn).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("returns 500 { error: 'storage_cleanup_failed' } and does NOT delete the project row when remove() fails", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    const stub = makeDeleteStub({
      listLevels: [
        { path: "project-1", data: [{ id: null, name: "doc-a" }], error: null },
        { path: "project-1/doc-a", data: [{ id: "obj-1", name: "content.txt" }], error: null },
      ],
      removeError: { message: "storage is down" },
    });
    mockGetServiceRoleClient.mockReturnValue(stub);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await DELETE(makeRequest("DELETE"), makeParams("project-1"));

    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("storage_cleanup_failed");
    expect(stub.__spies.deleteFn).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("returns 404 (not 200) when the DB delete matches zero rows -- lost a race with a concurrent DELETE", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    const stub = makeDeleteStub({ listLevels: [{ path: "project-1", data: [], error: null }], deletedRows: [] });
    mockGetServiceRoleClient.mockReturnValue(stub);

    const response = await DELETE(makeRequest("DELETE"), makeParams("project-1"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("treats an object found directly under the project prefix (no per-document sub-folder) defensively, including it in the remove() call", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    const stub = makeDeleteStub({
      listLevels: [{ path: "project-1", data: [{ id: "obj-stray", name: "stray.txt" }], error: null }],
    });
    mockGetServiceRoleClient.mockReturnValue(stub);

    const response = await DELETE(makeRequest("DELETE"), makeParams("project-1"));

    expect(response.status).toBe(200);
    expect(stub.__spies.remove).toHaveBeenCalledWith(["project-1/stray.txt"]);
  });
});
