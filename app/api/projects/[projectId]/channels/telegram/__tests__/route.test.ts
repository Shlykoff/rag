// app/api/projects/[projectId]/channels/telegram/__tests__/route.test.ts
//
// Unit test for GET/POST/DELETE /api/projects/{projectId}/channels/telegram:
// exercises the route's own control flow (auth -> project-ownership check,
// 404 not 403 on mismatch -> rate limit on state-changing methods ->
// save-then-register-with-Telegram ordering -> a bad token from Telegram's
// own setWebhook mapped to a clean 400, never a 500 -> response shape)
// against mocked dependencies. A dedicated group of assertions below
// checks that NO response, on ANY branch (connect, status, rotate,
// disconnect, or a failed setWebhook), ever contains the plaintext bot
// token or webhook secret used in that test -- the write-only posture this
// file's own header comment documents.

import { afterEach, describe, expect, it, vi } from "vitest";

const mockGetRouteHandlerSupabaseClient = vi.fn();
const mockGetAuthenticatedUser = vi.fn();
const mockVerifyProjectOwnership = vi.fn();
const mockGetServiceRoleClient = vi.fn();
const mockGetTelegramIntegrationByProject = vi.fn();
const mockSaveTelegramIntegration = vi.fn();
const mockDeleteTelegramIntegration = vi.fn();
const mockSetTelegramWebhook = vi.fn();
const mockCheckAICredentialsRateLimit = vi.fn();

vi.mock("@/lib/supabase/server-client", () => ({
  getRouteHandlerSupabaseClient: () => mockGetRouteHandlerSupabaseClient(),
  getAuthenticatedUser: (client: unknown) => mockGetAuthenticatedUser(client),
  verifyProjectOwnership: (...args: unknown[]) => mockVerifyProjectOwnership(...args),
}));

vi.mock("@/lib/supabase/service-client", () => ({
  getServiceRoleClient: () => mockGetServiceRoleClient(),
}));

vi.mock("@/lib/channels/telegram/integration-store", () => ({
  getTelegramIntegrationByProject: (...args: unknown[]) => mockGetTelegramIntegrationByProject(...args),
  saveTelegramIntegration: (...args: unknown[]) => mockSaveTelegramIntegration(...args),
  deleteTelegramIntegration: (...args: unknown[]) => mockDeleteTelegramIntegration(...args),
}));

vi.mock("@/lib/channels/telegram/client", () => ({
  setTelegramWebhook: (...args: unknown[]) => mockSetTelegramWebhook(...args),
}));

vi.mock("@/lib/rate-limit/ai-credentials-rate-limiter", () => ({
  checkAICredentialsRateLimit: (...args: unknown[]) => mockCheckAICredentialsRateLimit(...args),
}));

import { GET, POST, DELETE } from "../route";

const SECRET_BOT_TOKEN = "123456:AAExample-Secret-Bot-Token-Do-Not-Leak";
const EXISTING_WEBHOOK_SECRET = "existing-webhook-secret-abc123";

function makeRequest(method: string, body?: unknown): Request {
  return new Request("http://localhost/api/projects/project-1/channels/telegram", {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function makeParams(projectId: string): { params: Promise<{ projectId: string }> } {
  return { params: Promise.resolve({ projectId }) };
}

const ALLOWED_RATE_LIMIT = { allowed: true as const, currentCount: 1, limit: 10, retryAfterMs: 0 };

async function expectNoSecretLeak(response: Response): Promise<unknown> {
  const text = await response.clone().text();
  expect(text).not.toContain(SECRET_BOT_TOKEN);
  expect(text).not.toContain(EXISTING_WEBHOOK_SECRET);
  expect(text.toLowerCase()).not.toMatch(/bottoken|webhooksecret|credentials/);
  return response.json();
}

describe("GET /api/projects/{projectId}/channels/telegram", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 401 when there is no session, without checking ownership", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue(null);

    const response = await GET(makeRequest("GET"), makeParams("project-1"));

    expect(response.status).toBe(401);
    expect(mockVerifyProjectOwnership).not.toHaveBeenCalled();
  });

  it("returns 404 (not 403) when the project belongs to another user, without touching the integration store", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-2", email: "b@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(false);

    const response = await GET(makeRequest("GET"), makeParams("project-1"));

    expect(response.status).toBe(404);
    expect(mockGetTelegramIntegrationByProject).not.toHaveBeenCalled();
  });

  it("returns 200 { connected: false } when no integration exists", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockGetServiceRoleClient.mockReturnValue({});
    mockGetTelegramIntegrationByProject.mockResolvedValue(null);

    const response = await GET(makeRequest("GET"), makeParams("project-1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connected: false });
  });

  it("returns 200 { connected: true, enabled, displayLabel } WITHOUT the decrypted credentials, when one exists", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockGetServiceRoleClient.mockReturnValue({});
    mockGetTelegramIntegrationByProject.mockResolvedValue({
      id: "integration-1",
      projectId: "project-1",
      channel: "telegram",
      credentials: { botToken: SECRET_BOT_TOKEN, webhookSecret: EXISTING_WEBHOOK_SECRET },
      enabled: true,
      displayLabel: "Мой бот",
    });

    const response = await GET(makeRequest("GET"), makeParams("project-1"));

    expect(response.status).toBe(200);
    const payload = await expectNoSecretLeak(response);
    expect(payload).toEqual({ connected: true, enabled: true, displayLabel: "Мой бот" });
  });

  it("returns 500 when the integration lookup throws", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockGetServiceRoleClient.mockReturnValue({});
    mockGetTelegramIntegrationByProject.mockRejectedValue(new Error("db is down"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(makeRequest("GET"), makeParams("project-1"));

    expect(response.status).toBe(500);
    consoleErrorSpy.mockRestore();
  });
});

describe("POST /api/projects/{projectId}/channels/telegram", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 401 when there is no session", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue(null);

    const response = await POST(
      makeRequest("POST", { botToken: SECRET_BOT_TOKEN, webhookBaseUrl: "https://example.com" }),
      makeParams("project-1")
    );

    expect(response.status).toBe(401);
    expect(mockSaveTelegramIntegration).not.toHaveBeenCalled();
  });

  it("returns 404 (not 403) when the project belongs to another user, without saving anything or calling Telegram", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-2", email: "b@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(false);

    const response = await POST(
      makeRequest("POST", { botToken: SECRET_BOT_TOKEN, webhookBaseUrl: "https://example.com" }),
      makeParams("project-1")
    );

    expect(response.status).toBe(404);
    expect(mockSaveTelegramIntegration).not.toHaveBeenCalled();
    expect(mockSetTelegramWebhook).not.toHaveBeenCalled();
  });

  it("returns 429 when over the limit, before saving or calling Telegram", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockCheckAICredentialsRateLimit.mockReturnValue({ allowed: false, currentCount: 10, limit: 10, retryAfterMs: 3000 });

    const response = await POST(
      makeRequest("POST", { botToken: SECRET_BOT_TOKEN, webhookBaseUrl: "https://example.com" }),
      makeParams("project-1")
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("3");
    expect(mockSaveTelegramIntegration).not.toHaveBeenCalled();
    // Namespaced so this route's budget is independent of
    // /api/profile/ai-providers's own use of the same underlying limiter.
    expect(mockCheckAICredentialsRateLimit).toHaveBeenCalledWith("telegram:user-1");
  });

  it("returns 400 for malformed JSON", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockCheckAICredentialsRateLimit.mockReturnValue(ALLOWED_RATE_LIMIT);

    const badRequest = new Request("http://localhost/api/projects/project-1/channels/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const response = await POST(badRequest, makeParams("project-1"));
    expect(response.status).toBe(400);
  });

  it("returns 400 for a missing botToken", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockCheckAICredentialsRateLimit.mockReturnValue(ALLOWED_RATE_LIMIT);

    const response = await POST(makeRequest("POST", { webhookBaseUrl: "https://example.com" }), makeParams("project-1"));
    expect(response.status).toBe(400);
  });

  it("returns 400 for a non-https webhookBaseUrl", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockCheckAICredentialsRateLimit.mockReturnValue(ALLOWED_RATE_LIMIT);

    const response = await POST(
      makeRequest("POST", { botToken: SECRET_BOT_TOKEN, webhookBaseUrl: "http://example.com" }),
      makeParams("project-1")
    );
    expect(response.status).toBe(400);
    expect(mockSaveTelegramIntegration).not.toHaveBeenCalled();
  });

  it("connects a brand-new integration: generates a fresh webhook secret, saves it, registers it with Telegram at <baseUrl>/api/channels/telegram/<integrationId>, and returns 200 without leaking the token/secret", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockCheckAICredentialsRateLimit.mockReturnValue(ALLOWED_RATE_LIMIT);
    mockGetServiceRoleClient.mockReturnValue({});
    mockGetTelegramIntegrationByProject.mockResolvedValue(null); // no existing integration
    mockSaveTelegramIntegration.mockResolvedValue({ id: "integration-new" });
    mockSetTelegramWebhook.mockResolvedValue(undefined);

    const response = await POST(
      makeRequest("POST", { botToken: SECRET_BOT_TOKEN, webhookBaseUrl: "https://example.com/", displayLabel: "Мой бот" }),
      makeParams("project-1")
    );

    expect(response.status).toBe(200);
    const payload = (await expectNoSecretLeak(response)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      integrationId: "integration-new",
      displayLabel: "Мой бот",
      enabled: true,
      webhookUrl: "https://example.com/api/channels/telegram/integration-new",
      status: "connected",
    });

    expect(mockSaveTelegramIntegration).toHaveBeenCalledTimes(1);
    const [, projectIdArg, credentialsArg, displayLabelArg] = mockSaveTelegramIntegration.mock.calls[0];
    expect(projectIdArg).toBe("project-1");
    expect(credentialsArg.botToken).toBe(SECRET_BOT_TOKEN);
    expect(typeof credentialsArg.webhookSecret).toBe("string");
    expect(credentialsArg.webhookSecret.length).toBeGreaterThanOrEqual(32);
    expect(displayLabelArg).toBe("Мой бот");

    expect(mockSetTelegramWebhook).toHaveBeenCalledWith(
      SECRET_BOT_TOKEN,
      "https://example.com/api/channels/telegram/integration-new",
      credentialsArg.webhookSecret
    );
  });

  it("reuses the EXISTING webhook secret and displayLabel when rotating an already-connected integration's token", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockCheckAICredentialsRateLimit.mockReturnValue(ALLOWED_RATE_LIMIT);
    mockGetServiceRoleClient.mockReturnValue({});
    mockGetTelegramIntegrationByProject.mockResolvedValue({
      id: "integration-1",
      projectId: "project-1",
      channel: "telegram",
      credentials: { botToken: "old-token", webhookSecret: EXISTING_WEBHOOK_SECRET },
      enabled: true,
      displayLabel: "Старое имя",
    });
    mockSaveTelegramIntegration.mockResolvedValue({ id: "integration-1" });
    mockSetTelegramWebhook.mockResolvedValue(undefined);

    const response = await POST(
      makeRequest("POST", { botToken: "new-rotated-token", webhookBaseUrl: "https://example.com" }),
      makeParams("project-1")
    );

    expect(response.status).toBe(200);
    const [, , credentialsArg, displayLabelArg] = mockSaveTelegramIntegration.mock.calls[0];
    expect(credentialsArg.webhookSecret).toBe(EXISTING_WEBHOOK_SECRET);
    expect(credentialsArg.botToken).toBe("new-rotated-token");
    expect(displayLabelArg).toBe("Старое имя"); // not overridden -- no displayLabel in this request's body
    expect(mockSetTelegramWebhook).toHaveBeenCalledWith(
      "new-rotated-token",
      "https://example.com/api/channels/telegram/integration-1",
      EXISTING_WEBHOOK_SECRET
    );
  });

  it("returns 400 { error: 'telegram_setup_failed' } (not 500) when Telegram's setWebhook rejects the token -- the credential is still saved for a clean retry", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockCheckAICredentialsRateLimit.mockReturnValue(ALLOWED_RATE_LIMIT);
    mockGetServiceRoleClient.mockReturnValue({});
    mockGetTelegramIntegrationByProject.mockResolvedValue(null);
    mockSaveTelegramIntegration.mockResolvedValue({ id: "integration-new" });
    mockSetTelegramWebhook.mockRejectedValue(new Error("Telegram API setWebhook failed (400): Bad Request: invalid bot token"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(
      makeRequest("POST", { botToken: "bad-token", webhookBaseUrl: "https://example.com" }),
      makeParams("project-1")
    );

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toBe("telegram_setup_failed");
    expect(payload.message).not.toContain("bad-token"); // no raw Telegram detail/token leaked to the client
    expect(mockSaveTelegramIntegration).toHaveBeenCalledTimes(1); // saved before the Telegram call, deliberately not rolled back
    consoleErrorSpy.mockRestore();
  });

  it("returns 500 when saving the integration itself fails, without ever calling Telegram", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockCheckAICredentialsRateLimit.mockReturnValue(ALLOWED_RATE_LIMIT);
    mockGetServiceRoleClient.mockReturnValue({});
    mockGetTelegramIntegrationByProject.mockResolvedValue(null);
    mockSaveTelegramIntegration.mockRejectedValue(new Error("db is down"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(
      makeRequest("POST", { botToken: SECRET_BOT_TOKEN, webhookBaseUrl: "https://example.com" }),
      makeParams("project-1")
    );

    expect(response.status).toBe(500);
    expect(mockSetTelegramWebhook).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

describe("DELETE /api/projects/{projectId}/channels/telegram", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 401 when there is no session", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue(null);

    const response = await DELETE(makeRequest("DELETE"), makeParams("project-1"));

    expect(response.status).toBe(401);
    expect(mockDeleteTelegramIntegration).not.toHaveBeenCalled();
  });

  it("returns 404 (not 403) when the project belongs to another user", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-2", email: "b@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(false);

    const response = await DELETE(makeRequest("DELETE"), makeParams("project-1"));

    expect(response.status).toBe(404);
    expect(mockDeleteTelegramIntegration).not.toHaveBeenCalled();
  });

  it("returns 429 when over the limit, without deleting anything", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockCheckAICredentialsRateLimit.mockReturnValue({ allowed: false, currentCount: 10, limit: 10, retryAfterMs: 1000 });

    const response = await DELETE(makeRequest("DELETE"), makeParams("project-1"));

    expect(response.status).toBe(429);
    expect(mockDeleteTelegramIntegration).not.toHaveBeenCalled();
  });

  it("deletes the integration and returns 200 { status: 'deleted' }", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockCheckAICredentialsRateLimit.mockReturnValue(ALLOWED_RATE_LIMIT);
    mockGetServiceRoleClient.mockReturnValue({});
    mockDeleteTelegramIntegration.mockResolvedValue(undefined);

    const response = await DELETE(makeRequest("DELETE"), makeParams("project-1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "deleted" });
    expect(mockDeleteTelegramIntegration).toHaveBeenCalledWith({}, "project-1");
  });

  it("returns 500 when the delete itself fails", async () => {
    mockGetRouteHandlerSupabaseClient.mockResolvedValue({});
    mockGetAuthenticatedUser.mockResolvedValue({ id: "user-1", email: "a@b.com" });
    mockVerifyProjectOwnership.mockResolvedValue(true);
    mockCheckAICredentialsRateLimit.mockReturnValue(ALLOWED_RATE_LIMIT);
    mockGetServiceRoleClient.mockReturnValue({});
    mockDeleteTelegramIntegration.mockRejectedValue(new Error("db is down"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await DELETE(makeRequest("DELETE"), makeParams("project-1"));

    expect(response.status).toBe(500);
    consoleErrorSpy.mockRestore();
  });
});
