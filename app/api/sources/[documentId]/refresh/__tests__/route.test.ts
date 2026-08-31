// app/api/sources/[documentId]/refresh/__tests__/route.test.ts
//
// Unit test for POST /api/sources/{documentId}/refresh: exercises the
// route's own control flow (uuid-shape guard -> auth -> loadOwnedDocument
// (fetch + project-ownership check) -> rate limit -> manual_upload
// rejection -> refetchByRef -> refreshDocumentFromSource) against a mocked
// Supabase client + mocked lib/sources/pipeline.ts, mirroring
// ../../[documentId]/__tests__/route.test.ts's style. loadOwnedDocument
// itself (app/api/sources/shared.ts) is NOT mocked -- it's plain,
// dependency-injected logic over the mocked `@/lib/supabase/server-client`
// module below, so exercising the real implementation here is both safe
// and the more faithful test of this route's actual wiring.

import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetSourceIngestRateLimitForTests } from "../../../../../../lib/rate-limit/source-ingest-rate-limiter";

const mockGetRouteHandlerSupabaseClient = vi.fn();
const mockGetAuthenticatedUser = vi.fn();
const mockVerifyProjectOwnership = vi.fn();
const mockGetServiceRoleClient = vi.fn();
const mockRefetchByRef = vi.fn();
const mockRefreshDocumentFromSource = vi.fn();

vi.mock("@/lib/supabase/server-client", () => ({
  getRouteHandlerSupabaseClient: () => mockGetRouteHandlerSupabaseClient(),
  getAuthenticatedUser: (client: unknown) => mockGetAuthenticatedUser(client),
  verifyProjectOwnership: (...args: unknown[]) => mockVerifyProjectOwnership(...args),
}));

vi.mock("@/lib/supabase/service-client", () => ({
  getServiceRoleClient: () => mockGetServiceRoleClient(),
}));

vi.mock("@/lib/sources/pipeline", () => ({
  refetchByRef: (...args: unknown[]) => mockRefetchByRef(...args),
  refreshDocumentFromSource: (...args: unknown[]) => mockRefreshDocumentFromSource(...args),
}));

import { POST } from "../route";

const VALID_DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

function makeRequest(documentId: string): Request {
  return new Request(`http://localhost/api/sources/${documentId}/refresh`, { method: "POST" });
}

function makeParams(documentId: string): { params: Promise<{ documentId: string }> } {
  return { params: Promise.resolve({ documentId }) };
}

/** Minimal fake of the one chained builder route.ts calls directly: .from("documents").select().eq().maybeSingle(). */
function makeSupabaseStub(doc: {
  id: string;
  project_id: string;
  title: string;
  source_type: "manual_upload" | "notion" | "url" | "google_drive";
  source_ref: string | null;
} | null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: doc, error: null });
  const selectEq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq: selectEq });
  const from = vi.fn((table: string) => {
    if (table !== "documents") throw new Error(`unexpected table: ${table}`);
    return { select };
  });
  return { from };
}

describe("POST /api/sources/{documentId}/refresh", () => {
  afterEach(() => {
    vi.clearAllMocks();
    __resetSourceIngestRateLimitForTests();
  });

  // Regression test for the uuid-shape-guard fix: a syntactically invalid
  // documentId used to reach `.eq("id", documentId)` against a real
  // Postgres `uuid` column and surface as an uncaught "invalid input syntax
  // for type uuid" 500, instead of this route's own documented 404.
  it("returns 404 (not a 500) for a syntactically invalid documentId, without touching auth or the DB", async () => {
    const response = await POST(makeRequest("not-a-uuid"), makeParams("not-a-uuid"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(mockGetRouteHandlerSupabaseClient).not.toHaveBeenCalled();
    expect(mockGetServiceRoleClient).not.toHaveBeenCalled();
  });

  it("returns 401 when there is no session, without touching the DB", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue(null);

    const response = await POST(makeRequest(VALID_DOCUMENT_ID), makeParams(VALID_DOCUMENT_ID));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(mockGetServiceRoleClient).not.toHaveBeenCalled();
  });

  it("returns 404 when the document doesn't exist", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockGetServiceRoleClient.mockReturnValue(makeSupabaseStub(null));

    const response = await POST(makeRequest(VALID_DOCUMENT_ID), makeParams(VALID_DOCUMENT_ID));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(mockVerifyProjectOwnership).not.toHaveBeenCalled();
  });

  it("returns 404 (not 403) when the document's project belongs to a different user", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockGetServiceRoleClient.mockReturnValue(
      makeSupabaseStub({ id: VALID_DOCUMENT_ID, project_id: PROJECT_ID, title: "Doc", source_type: "url", source_ref: "https://example.com" })
    );
    mockVerifyProjectOwnership.mockResolvedValue(false);

    const response = await POST(makeRequest(VALID_DOCUMENT_ID), makeParams(VALID_DOCUMENT_ID));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(mockRefetchByRef).not.toHaveBeenCalled();
  });

  it("returns 400 for a manual_upload document (nothing external to refresh)", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockGetServiceRoleClient.mockReturnValue(
      makeSupabaseStub({ id: VALID_DOCUMENT_ID, project_id: PROJECT_ID, title: "Doc", source_type: "manual_upload", source_ref: null })
    );
    mockVerifyProjectOwnership.mockResolvedValue(true);

    const response = await POST(makeRequest(VALID_DOCUMENT_ID), makeParams(VALID_DOCUMENT_ID));

    expect(response.status).toBe(400);
    expect(mockRefetchByRef).not.toHaveBeenCalled();
  });

  it("dispatches through the uniform refetchByRef entry point and returns 200 on success", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockGetServiceRoleClient.mockReturnValue(
      makeSupabaseStub({
        id: VALID_DOCUMENT_ID,
        project_id: PROJECT_ID,
        title: "Old title",
        source_type: "url",
        source_ref: "https://example.com/page",
      })
    );
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockRefetchByRef.mockResolvedValue({
      title: "New title",
      text: "Refreshed content.",
      object: { suffix: "content.txt", content: "Refreshed content.", contentType: "text/plain; charset=utf-8" },
    });
    mockRefreshDocumentFromSource.mockResolvedValue({ chunkCount: 3 });

    const response = await POST(makeRequest(VALID_DOCUMENT_ID), makeParams(VALID_DOCUMENT_ID));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ documentId: VALID_DOCUMENT_ID, chunkCount: 3, status: "ready" });
    expect(mockRefetchByRef).toHaveBeenCalledWith("url", "https://example.com/page", expect.anything(), {
      ownerUserId: "user-1",
    });
    expect(mockRefreshDocumentFromSource).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ documentId: VALID_DOCUMENT_ID, projectId: PROJECT_ID, title: "New title", text: "Refreshed content." })
    );
  });
});
