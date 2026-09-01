// app/api/sources/google-drive/__tests__/route.test.ts
//
// Regression coverage for the live bug this fixes, scoped to
// google-drive/route.ts's own per-file loop: unlike upload/notion/url/
// refresh (whose single ingest call propagates straight to the route's
// outer catch -> sourceErrorResponse()), this route wraps each file's
// upsertDocumentFromSource() call in its own try/catch so one file's
// (Drive-specific) failure doesn't abort the rest of the folder sync. That
// per-file catch has to specifically recognize
// AIProviderError{kind:"no_credentials"} and rethrow it rather than
// recording it as an ordinary per-file failure -- otherwise a user with no
// active AI provider would get back `{ imported: [{ status: "error" }, ...] }`
// for every single file (and N console.error log lines) instead of one
// clean 422, and the loop would burn through calling upsertDocumentFromSource
// for every remaining file even though every one of them is guaranteed to
// fail identically (see route.ts's loop comment).

import { afterEach, describe, expect, it, vi } from "vitest";
import { AIProviderError } from "@/lib/ai/errors";

const mockGetRouteHandlerSupabaseClient = vi.fn();
const mockGetAuthenticatedUser = vi.fn();
const mockVerifyProjectOwnership = vi.fn();
const mockGetServiceRoleClient = vi.fn();
const mockSyncGoogleDriveFolder = vi.fn();
const mockUpsertDocumentFromSource = vi.fn();

vi.mock("@/lib/supabase/server-client", () => ({
  getRouteHandlerSupabaseClient: () => mockGetRouteHandlerSupabaseClient(),
  getAuthenticatedUser: (client: unknown) => mockGetAuthenticatedUser(client),
  verifyProjectOwnership: (...args: unknown[]) => mockVerifyProjectOwnership(...args),
}));

vi.mock("@/lib/supabase/service-client", () => ({
  getServiceRoleClient: () => mockGetServiceRoleClient(),
}));

vi.mock("@/lib/sources/google-drive", () => ({
  syncGoogleDriveFolder: (...args: unknown[]) => mockSyncGoogleDriveFolder(...args),
}));

vi.mock("@/lib/sources/pipeline", () => ({
  upsertDocumentFromSource: (...args: unknown[]) => mockUpsertDocumentFromSource(...args),
}));

import { POST } from "../route";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/sources/google-drive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function noCredentialsError(): AIProviderError {
  return new AIProviderError({
    provider: "none",
    kind: "no_credentials",
    retryable: false,
    message: "getAIProviders: project project-1 has no active_ai_provider set.",
    userMessage: "Добавьте и выберите AI-провайдера для этого проекта, чтобы начать общаться с ассистентом.",
  });
}

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

describe("POST /api/sources/google-drive", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 { error: 'not_found' } when the project doesn't belong to the signed-in user, without touching Drive", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(false);

    const response = await POST(makeRequest({ projectId: PROJECT_ID, folderId: "folder-1" }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(mockSyncGoogleDriveFolder).not.toHaveBeenCalled();
  });

  // Files are now ingested with bounded concurrency (INGEST_CONCURRENCY in
  // route.ts), not strictly one-at-a-time -- so "fails fast" no longer
  // means "exactly one call, ever" for a folder bigger than the
  // concurrency cap: the first WAVE of concurrently-dispatched files may
  // all be attempted before any of their (identical) no_credentials
  // failures is observed, but every file BEYOND that first wave is never
  // even attempted. 10 files (comfortably more than the concurrency cap)
  // demonstrates the bounded-waste property this test is actually about,
  // without depending on the exact concurrency constant.
  it("returns 422 { error: 'no_credentials' } and stops well short of the whole folder, without logging it as a server error, when the project has no active AI provider", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockGetServiceRoleClient.mockReturnValue({});
    const TOTAL_FILES = 10;
    mockSyncGoogleDriveFolder.mockResolvedValue({
      imported: Array.from({ length: TOTAL_FILES }, (_, i) => ({
        sourceRef: `file-${i}`,
        title: `Doc ${i}`,
        text: "content",
      })),
      skipped: [],
    });
    mockUpsertDocumentFromSource.mockRejectedValue(noCredentialsError());
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(makeRequest({ projectId: PROJECT_ID, folderId: "folder-1" }));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "no_credentials",
      message: "Добавьте и выберите AI-провайдера для этого проекта, чтобы начать общаться с ассистентом.",
    });
    // Bounded to (at most) one concurrency wave's worth of attempts --
    // nowhere near all 10 files -- instead of retrying the same guaranteed
    // failure for every remaining file in the folder.
    expect(mockUpsertDocumentFromSource.mock.calls.length).toBeGreaterThan(0);
    expect(mockUpsertDocumentFromSource.mock.calls.length).toBeLessThan(TOTAL_FILES);
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  // Proves files are ingested with genuine (bounded, not unbounded --
  // see the next test) concurrency, not strictly one at a time.
  it("ingests multiple files concurrently rather than strictly sequentially", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockGetServiceRoleClient.mockReturnValue({});
    mockSyncGoogleDriveFolder.mockResolvedValue({
      imported: Array.from({ length: 8 }, (_, i) => ({ sourceRef: `file-${i}`, title: `Doc ${i}`, text: "content" })),
      skipped: [],
    });

    let inFlight = 0;
    let maxInFlight = 0;
    mockUpsertDocumentFromSource.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve(); // yield once so overlap is observable
      inFlight--;
      return { documentId: "doc-x", chunkCount: 1, created: true };
    });

    const response = await POST(makeRequest({ projectId: PROJECT_ID, folderId: "folder-1" }));

    expect(response.status).toBe(200);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("caps ingestion concurrency instead of firing every file in the folder at once", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockGetServiceRoleClient.mockReturnValue({});
    const TOTAL_FILES = 20;
    mockSyncGoogleDriveFolder.mockResolvedValue({
      imported: Array.from({ length: TOTAL_FILES }, (_, i) => ({ sourceRef: `file-${i}`, title: `Doc ${i}`, text: "content" })),
      skipped: [],
    });

    let inFlight = 0;
    let maxInFlight = 0;
    mockUpsertDocumentFromSource.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight--;
      return { documentId: "doc-x", chunkCount: 1, created: true };
    });

    const response = await POST(makeRequest({ projectId: PROJECT_ID, folderId: "folder-1" }));

    expect(response.status).toBe(200);
    expect(maxInFlight).toBeLessThan(TOTAL_FILES);
    expect(maxInFlight).toBeLessThanOrEqual(5);
  });

  it("still reports a genuinely per-file failure as status: 'error' for just that file and continues syncing the rest (unaffected by the no_credentials short-circuit)", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-2", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockGetServiceRoleClient.mockReturnValue({});
    mockSyncGoogleDriveFolder.mockResolvedValue({
      imported: [
        { sourceRef: "file-1", title: "Doc 1", text: "hello" },
        { sourceRef: "file-2", title: "Doc 2", text: "world" },
      ],
      skipped: [],
    });
    mockUpsertDocumentFromSource
      .mockRejectedValueOnce(new Error("transient embeddings API error"))
      .mockResolvedValueOnce({ documentId: "doc-2", chunkCount: 3, created: true });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(makeRequest({ projectId: PROJECT_ID, folderId: "folder-1" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      imported: [
        { fileId: "file-1", documentId: null, status: "error" },
        { fileId: "file-2", documentId: "doc-2", status: "ready" },
      ],
      skipped: [],
    });
    expect(mockUpsertDocumentFromSource).toHaveBeenCalledTimes(2);
    // A real per-file failure IS still logged, unlike no_credentials above.
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
