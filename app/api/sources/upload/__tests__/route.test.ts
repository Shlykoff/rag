import { afterEach, describe, expect, it, vi } from "vitest";

const mockGetRouteHandlerSupabaseClient = vi.fn();
const mockGetAuthenticatedUser = vi.fn();
const mockVerifyProjectOwnership = vi.fn();

vi.mock("@/lib/supabase/server-client", () => ({
  getRouteHandlerSupabaseClient: () => mockGetRouteHandlerSupabaseClient(),
  getAuthenticatedUser: (client: unknown) => mockGetAuthenticatedUser(client),
  verifyProjectOwnership: (...args: unknown[]) => mockVerifyProjectOwnership(...args),
}));
vi.mock("@/lib/supabase/service-client", () => ({ getServiceRoleClient: vi.fn() }));
vi.mock("@/lib/sources/pipeline", () => ({ createDocumentFromSource: vi.fn() }));

import { POST } from "../route";

function uploadRequest(projectId: string): Request {
  const form = new FormData();
  form.append("projectId", projectId);
  form.append("file", new File(["hello"], "a.txt", { type: "text/plain" }));
  return new Request("http://localhost/api/sources/upload", { method: "POST", body: form });
}

describe("POST /api/sources/upload", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 400 for a malformed projectId without querying the database", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });

    const response = await POST(uploadRequest("not-a-uuid"));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_request");
    expect(mockVerifyProjectOwnership).not.toHaveBeenCalled();
  });
});
