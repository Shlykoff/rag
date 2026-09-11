import { afterEach, describe, expect, it, vi } from "vitest";

const mockGetRouteHandlerSupabaseClient = vi.fn();
const mockGetAuthenticatedUser = vi.fn();
const mockSaveSourceCredential = vi.fn();
const mockHasSourceCredential = vi.fn();

vi.mock("@/lib/supabase/server-client", () => ({
  getRouteHandlerSupabaseClient: () => mockGetRouteHandlerSupabaseClient(),
  getAuthenticatedUser: (client: unknown) => mockGetAuthenticatedUser(client),
}));
vi.mock("@/lib/supabase/service-client", () => ({ getServiceRoleClient: () => ({}) }));
vi.mock("@/lib/sources/credentials", () => ({
  saveSourceCredential: (...args: unknown[]) => mockSaveSourceCredential(...args),
  hasSourceCredential: (...args: unknown[]) => mockHasSourceCredential(...args),
}));
vi.mock("@/lib/sources/google-drive", () => ({ isValidGoogleDriveCredentialFormat: () => true }));

import { GET, POST } from "../route";

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/sources/credentials", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function signedIn() {
  mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
  mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
}

describe("/api/sources/credentials", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("POST saves the credential and returns 200", async () => {
    signedIn();
    mockSaveSourceCredential.mockResolvedValue(undefined);

    const response = await POST(postRequest({ sourceType: "notion", credential: "secret_x" }));

    expect(response.status).toBe(200);
    expect(mockSaveSourceCredential).toHaveBeenCalledWith({}, "user-1", "notion", "secret_x");
  });

  it("POST returns a JSON 500 that echoes neither the secret nor the DB error", async () => {
    signedIn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockSaveSourceCredential.mockRejectedValue(new Error("db down"));

    const response = await POST(postRequest({ sourceType: "notion", credential: "secret_x" }));

    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload.error).toBe("internal_error");
    expect(JSON.stringify(payload)).not.toMatch(/secret_x|db down/);
  });

  it("GET returns a JSON 500 instead of throwing when the lookup fails", async () => {
    signedIn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockHasSourceCredential.mockRejectedValue(new Error("db down"));

    const response = await GET();

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "internal_error" });
  });
});
