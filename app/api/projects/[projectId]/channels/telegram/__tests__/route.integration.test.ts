// app/api/projects/[projectId]/channels/telegram/__tests__/route.integration.test.ts
//
// Runs against a REAL local Supabase. Only lib/channels/telegram/client.ts's
// setTelegramWebhook and getTelegramWebhookInfo (the two genuine outbound
// network calls to Telegram's own API) are mocked -- everything else,
// including the AES-256-GCM encrypt/decrypt round trip through real
// Postgres bytea columns (lib/channels/telegram/integration-store.ts, NOT
// mocked) and real Postgres RLS for cross-user ownership
// (verifyProjectOwnership NOT mocked, only auth resolution is -- same
// pattern as the sibling
// ../../__tests__/route.integration.test.ts / .../model/__tests__/route.integration.test.ts),
// is real. This is what proves three things the mocked unit test
// (../route.test.ts) can only assert "should work" for:
//   1. A second real user genuinely cannot read/connect/disconnect
//      another owner's Telegram integration (real RLS-backed 404).
//   2. The bot token is NEVER present in any HTTP response body, at any
//      point in the connect/status/disconnect lifecycle -- checked against
//      the actual decrypted value read back from real Postgres, not a
//      value this test merely assumes was stored.
//   3. qa-reviewer's exact live repro (submit an invalid token, then
//      reload the status screen -- GET) no longer reports "connected" with
//      no further caveat: a real GET reads `webhookStatus` off a mocked
//      getTelegramWebhookInfo the same way it would read Telegram's own
//      live state, and correctly reports "unconfirmed" for a row saved
//      after a failed setWebhook.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createAuthenticatedTestUser,
  createTestProject,
  deleteTestUser,
  hasIntegrationEnv,
  makeIntegrationSupabaseClient,
} from "../../../../../../../lib/testing/integration-helpers";

let currentUser: { id: string; email: string } | null = null;
let currentAuthClient: SupabaseClient;

vi.mock("@/lib/supabase/server-client", async () => {
  const actual = await vi.importActual<typeof import("../../../../../../../lib/supabase/server-client")>(
    "../../../../../../../lib/supabase/server-client"
  );
  return {
    getRouteHandlerSupabaseClient: async () => currentAuthClient,
    getAuthenticatedUser: async () => currentUser,
    verifyProjectOwnership: actual.verifyProjectOwnership,
  };
});

const mockSetTelegramWebhook = vi.fn();
const mockGetTelegramWebhookInfo = vi.fn();
vi.mock("@/lib/channels/telegram/client", () => ({
  setTelegramWebhook: (...args: unknown[]) => mockSetTelegramWebhook(...args),
  getTelegramWebhookInfo: (...args: unknown[]) => mockGetTelegramWebhookInfo(...args),
}));

// NOT mocked: lib/supabase/service-client.ts, lib/channels/telegram/
// integration-store.ts's real encrypt/decrypt + DB calls, and
// lib/rate-limit/ai-credentials-rate-limiter.ts (in-memory, keyed by a
// fresh random user id per test below, so no cross-test interference) all
// talk to / run against the real local Supabase started by
// `supabase start` (NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/
// CREDENTIALS_ENCRYPTION_KEY loaded from .env.local by `npm run
// test:integration`'s --env-file flag).
import { GET, POST, DELETE } from "../route";
import { getTelegramIntegrationByProject } from "@/lib/channels/telegram/integration-store";

function makeRequest(method: string, body?: unknown): Request {
  return new Request("http://localhost/api/projects/x/channels/telegram", {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function makeParams(projectId: string): { params: Promise<{ projectId: string }> } {
  return { params: Promise.resolve({ projectId }) };
}

describe.skipIf(!hasIntegrationEnv() || !process.env.CREDENTIALS_ENCRYPTION_KEY)(
  "GET/POST/DELETE /api/projects/{projectId}/channels/telegram (integration, real Supabase)",
  () => {
    let serviceClient: SupabaseClient;
    let ownerA: { id: string; email: string; client: SupabaseClient };
    let ownerB: { id: string; email: string; client: SupabaseClient };

    beforeAll(async () => {
      serviceClient = makeIntegrationSupabaseClient();
      ownerA = await createAuthenticatedTestUser(serviceClient, "telegram-route-owner-a");
      ownerB = await createAuthenticatedTestUser(serviceClient, "telegram-route-owner-b");
    });

    afterAll(async () => {
      if (ownerA) await deleteTestUser(serviceClient, ownerA.id);
      if (ownerB) await deleteTestUser(serviceClient, ownerB.id);
    });

    afterEach(() => {
      currentUser = null;
      mockSetTelegramWebhook.mockReset();
      mockGetTelegramWebhookInfo.mockReset();
    });

    it("a real second user gets 404 (not 403) on GET/POST/DELETE for a project they don't own, and no integration is created", async () => {
      const project = await createTestProject(serviceClient, ownerA.id, "Owner A's project");

      currentAuthClient = ownerB.client;
      currentUser = { id: ownerB.id, email: ownerB.email };

      const getResponse = await GET(makeRequest("GET"), makeParams(project.id));
      expect(getResponse.status).toBe(404);

      const postResponse = await POST(
        makeRequest("POST", { botToken: "123456:hijack-attempt", webhookBaseUrl: "https://example.com" }),
        makeParams(project.id)
      );
      expect(postResponse.status).toBe(404);
      expect(mockSetTelegramWebhook).not.toHaveBeenCalled();

      const deleteResponse = await DELETE(makeRequest("DELETE"), makeParams(project.id));
      expect(deleteResponse.status).toBe(404);

      const integration = await getTelegramIntegrationByProject(serviceClient, project.id);
      expect(integration).toBeNull();
    });

    it("connects a real integration (real encrypt/decrypt), never leaks the bot token in any response, and a subsequent GET/DELETE round-trips it", async () => {
      const project = await createTestProject(serviceClient, ownerA.id, "Telegram round trip");
      currentAuthClient = ownerA.client;
      currentUser = { id: ownerA.id, email: ownerA.email };
      mockSetTelegramWebhook.mockResolvedValue(undefined);

      const realBotToken = `123456:integration-test-real-token-${project.id}`;

      const postResponse = await POST(
        makeRequest("POST", { botToken: realBotToken, webhookBaseUrl: "https://example.com/", displayLabel: "Мой тестовый бот" }),
        makeParams(project.id)
      );
      expect(postResponse.status).toBe(200);
      const postText = await postResponse.clone().text();
      expect(postText).not.toContain(realBotToken);
      const postBody = await postResponse.json();
      expect(postBody).toMatchObject({
        displayLabel: "Мой тестовый бот",
        enabled: true,
        webhookUrl: `https://example.com/api/channels/telegram/${postBody.integrationId}`,
        webhookStatus: "confirmed",
        status: "connected",
      });

      // setTelegramWebhook was actually called with the real token + the
      // real webhook URL built from this integration's own id.
      expect(mockSetTelegramWebhook).toHaveBeenCalledWith(
        realBotToken,
        `https://example.com/api/channels/telegram/${postBody.integrationId}`,
        expect.any(String)
      );

      // The credential really is stored encrypted and really does decrypt
      // back to the exact value submitted -- read independently via the
      // (real, unmocked) integration store, not assumed.
      const stored = await getTelegramIntegrationByProject(serviceClient, project.id);
      expect(stored?.credentials.botToken).toBe(realBotToken);

      // GET's webhookStatus comes from a live getTelegramWebhookInfo call --
      // mocked here (a real call would hit Telegram's actual API), told to
      // report exactly the URL this integration's own POST just "registered".
      mockGetTelegramWebhookInfo.mockResolvedValue({ url: `https://example.com/api/channels/telegram/${postBody.integrationId}` });

      const getResponse = await GET(makeRequest("GET"), makeParams(project.id));
      expect(getResponse.status).toBe(200);
      const getText = await getResponse.clone().text();
      expect(getText).not.toContain(realBotToken);
      expect(await getResponse.json()).toEqual({
        connected: true,
        enabled: true,
        displayLabel: "Мой тестовый бот",
        webhookStatus: "confirmed",
      });

      const deleteResponse = await DELETE(makeRequest("DELETE"), makeParams(project.id));
      expect(deleteResponse.status).toBe(200);
      expect(await deleteResponse.json()).toEqual({ status: "deleted" });

      const afterDelete = await GET(makeRequest("GET"), makeParams(project.id));
      expect(await afterDelete.json()).toEqual({ connected: false });
    });

    it("returns a real 400 { error: 'telegram_setup_failed' } (not 500) when Telegram's own API rejects the token, and never echoes the token back", async () => {
      const project = await createTestProject(serviceClient, ownerA.id, "Bad token");
      currentAuthClient = ownerA.client;
      currentUser = { id: ownerA.id, email: ownerA.email };
      mockSetTelegramWebhook.mockRejectedValue(
        new Error("Telegram API setWebhook failed (400): Bad Request: invalid bot token (<redacted>)")
      );

      const badToken = "123456:this-token-is-rejected-by-telegram";
      const response = await POST(
        makeRequest("POST", { botToken: badToken, webhookBaseUrl: "https://example.com" }),
        makeParams(project.id)
      );

      expect(response.status).toBe(400);
      const text = await response.clone().text();
      expect(text).not.toContain(badToken);
      expect((await response.json()).error).toBe("telegram_setup_failed");

      // The credential is still saved (matches scripts/telegram-set-webhook.ts's
      // own accepted save-then-register ordering, see route.ts's header) --
      // a corrected re-POST is expected to succeed without a separate step.
      const stored = await getTelegramIntegrationByProject(serviceClient, project.id);
      expect(stored?.credentials.botToken).toBe(badToken);

      // qa-reviewer's exact regression repro: reloading the status screen
      // (GET) after a failed setWebhook must NOT falsely report the bot as
      // live -- Telegram genuinely has no webhook registered for a token it
      // just rejected, so the live check reports that honestly instead of
      // a bare row-existence "connected".
      mockGetTelegramWebhookInfo.mockResolvedValue({ url: "" });
      const getResponse = await GET(makeRequest("GET"), makeParams(project.id));
      expect(getResponse.status).toBe(200);
      expect(await getResponse.json()).toEqual({
        connected: true,
        enabled: true,
        displayLabel: null,
        webhookStatus: "unconfirmed",
      });
    });
  }
);
