// app/api/channels/telegram/[integrationId]/__tests__/route.test.ts
//
// Unit test for the webhook route's own (deliberately thin) control flow:
// service-role lookup of the integration by path id, delegate to
// lib/channels/telegram/adapter.ts's handleTelegramWebhook(), and --
// critically -- ALWAYS return 200, regardless of what happened internally
// (unknown/disabled integration, or an unexpected exception anywhere in
// the delegated call). See route.ts's own header comment for why: Telegram
// retries on any non-2xx or slow response.

import { afterEach, describe, expect, it, vi } from "vitest";

const mockGetServiceRoleClient = vi.fn();
const mockGetTelegramIntegrationById = vi.fn();
const mockHandleTelegramWebhook = vi.fn();

vi.mock("@/lib/supabase/service-client", () => ({
  getServiceRoleClient: () => mockGetServiceRoleClient(),
}));

vi.mock("@/lib/channels/telegram/integration-store", () => ({
  getTelegramIntegrationById: (...args: unknown[]) => mockGetTelegramIntegrationById(...args),
}));

vi.mock("@/lib/channels/telegram/adapter", () => ({
  handleTelegramWebhook: (...args: unknown[]) => mockHandleTelegramWebhook(...args),
}));

import { POST } from "../route";

function makeRequest(body: unknown = { update_id: 1 }): Request {
  return new Request("http://localhost/api/channels/telegram/integration-1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeParams(integrationId: string): { params: Promise<{ integrationId: string }> } {
  return { params: Promise.resolve({ integrationId }) };
}

const ENABLED_INTEGRATION = {
  id: "integration-1",
  projectId: "project-1",
  channel: "telegram" as const,
  credentials: { botToken: "x", webhookSecret: "y" },
  enabled: true,
  displayLabel: null,
};

describe("POST /api/channels/telegram/{integrationId}", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 and delegates to handleTelegramWebhook for a known, enabled integration", async () => {
    mockGetServiceRoleClient.mockReturnValue({});
    mockGetTelegramIntegrationById.mockResolvedValue(ENABLED_INTEGRATION);
    mockHandleTelegramWebhook.mockResolvedValue(undefined);

    const response = await POST(makeRequest(), makeParams("integration-1"));

    expect(response.status).toBe(200);
    expect(mockHandleTelegramWebhook).toHaveBeenCalledWith(expect.any(Request), ENABLED_INTEGRATION);
  });

  it("returns 200 (never 404) for an unknown integration id, without calling handleTelegramWebhook", async () => {
    mockGetServiceRoleClient.mockReturnValue({});
    mockGetTelegramIntegrationById.mockResolvedValue(null);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(makeRequest(), makeParams("does-not-exist"));

    expect(response.status).toBe(200);
    expect(mockHandleTelegramWebhook).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("returns 200 for a disabled integration, without calling handleTelegramWebhook", async () => {
    mockGetServiceRoleClient.mockReturnValue({});
    mockGetTelegramIntegrationById.mockResolvedValue({ ...ENABLED_INTEGRATION, enabled: false });

    const response = await POST(makeRequest(), makeParams("integration-1"));

    expect(response.status).toBe(200);
    expect(mockHandleTelegramWebhook).not.toHaveBeenCalled();
  });

  it("returns 200 even when handleTelegramWebhook throws an unexpected exception -- the route's own defensive backstop", async () => {
    mockGetServiceRoleClient.mockReturnValue({});
    mockGetTelegramIntegrationById.mockResolvedValue(ENABLED_INTEGRATION);
    mockHandleTelegramWebhook.mockRejectedValue(new Error("unexpected boom"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(makeRequest(), makeParams("integration-1"));

    expect(response.status).toBe(200);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("returns 200 even when the integration lookup itself throws", async () => {
    mockGetServiceRoleClient.mockReturnValue({});
    mockGetTelegramIntegrationById.mockRejectedValue(new Error("db is down"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(makeRequest(), makeParams("integration-1"));

    expect(response.status).toBe(200);
    consoleErrorSpy.mockRestore();
  });

  it("a non-text update (e.g. a sticker) still results in 200, delegated to the adapter without special-casing at the route level", async () => {
    mockGetServiceRoleClient.mockReturnValue({});
    mockGetTelegramIntegrationById.mockResolvedValue(ENABLED_INTEGRATION);
    mockHandleTelegramWebhook.mockResolvedValue(undefined);

    const stickerUpdate = { update_id: 2, message: { chat: { id: 1 }, sticker: { file_id: "abc" } } };
    const response = await POST(makeRequest(stickerUpdate), makeParams("integration-1"));

    expect(response.status).toBe(200);
    expect(mockHandleTelegramWebhook).toHaveBeenCalledTimes(1);
  });
});
