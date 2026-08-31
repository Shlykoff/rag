// app/api/sources/[documentId]/__tests__/route.test.ts
//
// Unit test for DELETE /api/sources/{documentId}: exercises the route's own
// control flow (auth -> fetch document's project_id -> project-ownership
// check -> DB delete-before-Storage-remove ordering -> response shape)
// against a mocked Supabase client, mirroring
// app/api/chat/__tests__/route.test.ts's style. The live end-to-end path
// (real DB row + real document_chunks cascade + real Storage object) is
// verified manually against local Supabase -- see this task's report, not
// re-asserted here since it'd require a live Docker Supabase to run in CI.
//
// PROJECTS PIVOT: `documents` has no `user_id` column anymore -- ownership
// is derived through `project_id`, verified via a SEPARATE mocked
// `authClient` (RLS-scoped session client) rather than baked into the
// service-role query filter. `mockVerifyProjectOwnership` below stands in
// for lib/supabase/server-client.ts's real RLS-backed check.

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

import { DELETE } from "../route";

function makeRequest(documentId: string): Request {
  return new Request(`http://localhost/api/sources/${documentId}`, { method: "DELETE" });
}

function makeParams(documentId: string): { params: Promise<{ documentId: string }> } {
  return { params: Promise.resolve({ documentId }) };
}

/** Minimal fake of the two chained builders route.ts calls: .from("documents").select/delete and .storage.from("documents").remove. */
function makeSupabaseStub(options: {
  doc: { id: string; project_id: string; storage_path: string | null } | null;
  selectError?: { message: string } | null;
  deleteError?: { message: string } | null;
  // Rows the `.delete().eq().select("id")` chain reports as actually
  // deleted -- defaults to "the delete matched the row" ([{ id: doc.id }]).
  // Set to [] to simulate the race-loser case (see the "parallel DELETE"
  // test below): a delete that matched zero rows, which PostgREST reports
  // as `error: null, data: []`, NOT as an error.
  deletedRows?: { id: string }[];
  storageRemoveError?: { message: string } | null;
}) {
  const remove = vi.fn().mockResolvedValue({ error: options.storageRemoveError ?? null });
  const defaultDeletedRows = options.doc ? [{ id: options.doc.id }] : [];
  const deleteSelect = vi
    .fn()
    .mockResolvedValue({ data: options.deleteError ? null : (options.deletedRows ?? defaultDeletedRows), error: options.deleteError ?? null });
  const deleteEqId = vi.fn().mockReturnValue({ select: deleteSelect });
  const deleteFn = vi.fn().mockReturnValue({ eq: deleteEqId });

  const maybeSingle = vi.fn().mockResolvedValue({ data: options.doc, error: options.selectError ?? null });
  const selectEq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq: selectEq });

  const from = vi.fn((table: string) => {
    if (table !== "documents") throw new Error(`unexpected table: ${table}`);
    return { select, delete: deleteFn };
  });

  return {
    from,
    storage: { from: vi.fn().mockReturnValue({ remove }) },
    __spies: { remove, deleteEqId, deleteSelect, deleteFn, select },
  };
}

describe("DELETE /api/sources/{documentId}", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 { error: 'unauthorized' } when there is no session, without touching the DB", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue(null);

    const response = await DELETE(makeRequest("11111111-1111-4111-8111-111111111111"), makeParams("11111111-1111-4111-8111-111111111111"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(mockGetServiceRoleClient).not.toHaveBeenCalled();
  });

  // Regression test: a syntactically-invalid documentId used to reach
  // `.eq("id", documentId)` against a real Postgres `uuid` column and come
  // back as an uncaught "invalid input syntax for type uuid" error (a bare
  // 500), instead of this route's own documented 404. Never even reaches
  // auth/the DB now.
  it("returns 404 (not a 500) for a syntactically invalid documentId, without touching auth or the DB", async () => {
    const response = await DELETE(makeRequest("not-a-uuid"), makeParams("not-a-uuid"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(mockGetRouteHandlerSupabaseClient).not.toHaveBeenCalled();
    expect(mockGetServiceRoleClient).not.toHaveBeenCalled();
  });

  it("returns 404 { error: 'not_found' } when the document doesn't exist", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    const stub = makeSupabaseStub({ doc: null });
    mockGetServiceRoleClient.mockReturnValue(stub);

    const response = await DELETE(makeRequest("99999999-9999-4999-8999-999999999999"), makeParams("99999999-9999-4999-8999-999999999999"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(stub.__spies.deleteFn).not.toHaveBeenCalled();
    expect(mockVerifyProjectOwnership).not.toHaveBeenCalled();
  });

  it("returns 404 { error: 'not_found' } (not 403) when the document's project belongs to a different user", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    const stub = makeSupabaseStub({
      doc: { id: "11111111-1111-4111-8111-111111111111", project_id: "someone-elses-project", storage_path: "someone-elses-project/11111111-1111-4111-8111-111111111111/content.txt" },
    });
    mockGetServiceRoleClient.mockReturnValue(stub);
    mockVerifyProjectOwnership.mockResolvedValue(false);

    const response = await DELETE(makeRequest("11111111-1111-4111-8111-111111111111"), makeParams("11111111-1111-4111-8111-111111111111"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(stub.__spies.deleteFn).not.toHaveBeenCalled();
    expect(mockVerifyProjectOwnership).toHaveBeenCalledWith({}, "someone-elses-project");
  });

  it("deletes the documents row, then removes the Storage object, and returns 200 { documentId, status: 'deleted' }", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    const stub = makeSupabaseStub({
      doc: { id: "11111111-1111-4111-8111-111111111111", project_id: "project-1", storage_path: "project-1/11111111-1111-4111-8111-111111111111/content.txt" },
    });
    mockGetServiceRoleClient.mockReturnValue(stub);
    mockVerifyProjectOwnership.mockResolvedValue(true);

    const callOrder: string[] = [];
    stub.__spies.deleteFn.mockImplementation(() => {
      callOrder.push("db-delete");
      return {
        eq: vi.fn().mockReturnValue({ select: vi.fn().mockResolvedValue({ data: [{ id: "11111111-1111-4111-8111-111111111111" }], error: null }) }),
      };
    });
    stub.__spies.remove.mockImplementation(async () => {
      callOrder.push("storage-remove");
      return { error: null };
    });

    const response = await DELETE(makeRequest("11111111-1111-4111-8111-111111111111"), makeParams("11111111-1111-4111-8111-111111111111"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ documentId: "11111111-1111-4111-8111-111111111111", status: "deleted" });
    expect(stub.__spies.remove).toHaveBeenCalledWith(["project-1/11111111-1111-4111-8111-111111111111/content.txt"]);
    // DB delete (and its cascade to document_chunks) must happen before the
    // Storage object is removed -- see route.ts's ordering comment.
    expect(callOrder).toEqual(["db-delete", "storage-remove"]);
  });

  it("skips the Storage removal entirely when storage_path is null", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    const stub = makeSupabaseStub({ doc: { id: "11111111-1111-4111-8111-111111111111", project_id: "project-1", storage_path: null } });
    mockGetServiceRoleClient.mockReturnValue(stub);
    mockVerifyProjectOwnership.mockResolvedValue(true);

    const response = await DELETE(makeRequest("11111111-1111-4111-8111-111111111111"), makeParams("11111111-1111-4111-8111-111111111111"));

    expect(response.status).toBe(200);
    expect(stub.__spies.remove).not.toHaveBeenCalled();
  });

  it("still returns 200 (not an error) when the Storage remove fails after a successful DB delete", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    const stub = makeSupabaseStub({
      doc: { id: "11111111-1111-4111-8111-111111111111", project_id: "project-1", storage_path: "project-1/11111111-1111-4111-8111-111111111111/content.txt" },
      storageRemoveError: { message: "storage is down" },
    });
    mockGetServiceRoleClient.mockReturnValue(stub);
    mockVerifyProjectOwnership.mockResolvedValue(true);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await DELETE(makeRequest("11111111-1111-4111-8111-111111111111"), makeParams("11111111-1111-4111-8111-111111111111"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ documentId: "11111111-1111-4111-8111-111111111111", status: "deleted" });
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("returns 500 when the DB delete itself fails (the document is not confirmed removed)", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    const stub = makeSupabaseStub({
      doc: { id: "11111111-1111-4111-8111-111111111111", project_id: "project-1", storage_path: "project-1/11111111-1111-4111-8111-111111111111/content.txt" },
      deleteError: { message: "db is down" },
    });
    mockGetServiceRoleClient.mockReturnValue(stub);
    mockVerifyProjectOwnership.mockResolvedValue(true);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await DELETE(makeRequest("11111111-1111-4111-8111-111111111111"), makeParams("11111111-1111-4111-8111-111111111111"));

    expect(response.status).toBe(500);
    expect(stub.__spies.remove).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  // Regression test for the race qa-reviewer found: two concurrent DELETEs
  // for the same document. Both pass the ownership check above, but
  // PostgREST reports the DB delete itself matching zero rows for whichever
  // one runs second -- `data: [], error: null`, not an error (see
  // route.ts's `.select("id")` comment, and the live Promise.all
  // reproduction against real Postgres in this task's report). This unit
  // test simulates that "lost the race" outcome directly via the stub,
  // since a true concurrent-request race can't be reproduced against a
  // mock; the integration test (route.integration.test.ts) reproduces it
  // for real.
  it("returns 404 (not 200) when the DB delete matches zero rows -- lost a race with a concurrent DELETE, and skips the Storage remove", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    const stub = makeSupabaseStub({
      doc: { id: "11111111-1111-4111-8111-111111111111", project_id: "project-1", storage_path: "project-1/11111111-1111-4111-8111-111111111111/content.txt" },
      deletedRows: [], // <- the row was already gone by the time this DELETE ran
    });
    mockGetServiceRoleClient.mockReturnValue(stub);
    mockVerifyProjectOwnership.mockResolvedValue(true);

    const response = await DELETE(makeRequest("11111111-1111-4111-8111-111111111111"), makeParams("11111111-1111-4111-8111-111111111111"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(stub.__spies.remove).not.toHaveBeenCalled();
  });
});
