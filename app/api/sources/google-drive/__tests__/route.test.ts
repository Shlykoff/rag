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

  it("returns 422 { error: 'no_credentials' } and stops after the first file, without logging it as a server error, when the project has no active AI provider", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockGetServiceRoleClient.mockReturnValue({});
    mockSyncGoogleDriveFolder.mockResolvedValue({
      imported: [
        { sourceRef: "file-1", title: "Doc 1", text: "hello" },
        { sourceRef: "file-2", title: "Doc 2", text: "world" },
      ],
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
    // Fails fast on the first file instead of retrying the same guaranteed
    // failure for every remaining file in the folder.
    expect(mockUpsertDocumentFromSource).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
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
