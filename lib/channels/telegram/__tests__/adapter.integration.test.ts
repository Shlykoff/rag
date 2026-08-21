// lib/channels/telegram/__tests__/adapter.integration.test.ts
//
// Runs against a REAL local Supabase -- proves the ONE thing that cannot
// be faked with a mocked Supabase client: that `channel_processed_updates`'
// composite primary key genuinely makes a duplicate/concurrent Telegram
// `update_id` delivery race-safe end to end through
// lib/channels/telegram/adapter.ts's real claimUpdate() call (not a fake
// that's just told to behave that way). `lib/gateway/answer.ts` is mocked
// (same "mock the one seam" pattern as
// lib/gateway/__tests__/answer.integration.test.ts's own header explains
// for `lib/ai`) -- no real Telegram account or AI provider key needed.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestProject,
  createTestUser,
  deleteTestUser,
  hasIntegrationEnv,
  makeIntegrationSupabaseClient,
} from "../../../testing/integration-helpers";

const mockAnswerExternalMessage = vi.fn();

vi.mock("../../../gateway/answer", () => ({
  answerExternalMessage: (...args: unknown[]) => mockAnswerExternalMessage(...args),
}));

// Static import after vi.mock is safe -- Vitest hoists vi.mock calls above
// imports.
import { handleTelegramWebhook } from "../adapter";
import { saveTelegramIntegration, getTelegramIntegrationById } from "../integration-store";

describe.skipIf(!hasIntegrationEnv() || !process.env.CREDENTIALS_ENCRYPTION_KEY)(
  "telegram adapter (integration, real Supabase)",
  () => {
    let supabase: SupabaseClient;
    let userId: string;
    let projectId: string;
    let integrationId: string;
    const webhookSecret = "integration-test-webhook-secret";

    beforeAll(async () => {
      supabase = makeIntegrationSupabaseClient();
      const user = await createTestUser(supabase, "telegram-adapter");
      userId = user.id;
      projectId = (await createTestProject(supabase, userId)).id;
      const saved = await saveTelegramIntegration(supabase, projectId, {
        botToken: "123456:fake-integration-test-token",
        webhookSecret,
      });
      integrationId = saved.id;
    });

    afterAll(async () => {
      if (userId) await deleteTestUser(supabase, userId);
    });

    afterEach(() => {
      mockAnswerExternalMessage.mockClear();
    });

    function makeRequest(body: unknown): Request {
      return new Request(`http://localhost/api/channels/telegram/${integrationId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": webhookSecret },
        body: JSON.stringify(body),
      });
    }

    it("getTelegramIntegrationById round-trips the encrypted { botToken, webhookSecret } through real Postgres bytea encoding", async () => {
      const integration = await getTelegramIntegrationById(supabase, integrationId);
      expect(integration).not.toBeNull();
      expect(integration?.credentials).toEqual({ botToken: "123456:fake-integration-test-token", webhookSecret });
      expect(integration?.projectId).toBe(projectId);
      expect(integration?.channel).toBe("telegram");
      expect(integration?.enabled).toBe(true);
    });

    it("channel_processed_updates genuinely prevents double-processing: two SEQUENTIAL deliveries of the same update_id only reach the gateway once", async () => {
      mockAnswerExternalMessage.mockResolvedValue({ kind: "ok", text: "answer" });
      const integration = await getTelegramIntegrationById(supabase, integrationId);
      if (!integration) throw new Error("integration not found");

      const update = { update_id: 9001, message: { chat: { id: 4242 }, text: "hello" } };

      await handleTelegramWebhook(makeRequest(update), integration);
      // Simulated Telegram retry: the exact same update_id delivered again.
      await handleTelegramWebhook(makeRequest(update), integration);

      expect(mockAnswerExternalMessage).toHaveBeenCalledTimes(1);

      const { data: claimed, error } = await supabase
        .from("channel_processed_updates")
        .select("update_id")
        .eq("integration_id", integrationId)
        .eq("update_id", 9001);
      if (error) throw new Error(error.message);
      expect(claimed).toHaveLength(1); // still exactly one row, not two
    });

    it("two truly CONCURRENT deliveries of the same update_id (a real race, not sequential) also only process once -- the DB constraint, not application logic, is what makes this safe", async () => {
      mockAnswerExternalMessage.mockResolvedValue({ kind: "ok", text: "answer" });
      const integration = await getTelegramIntegrationById(supabase, integrationId);
      if (!integration) throw new Error("integration not found");

      const update = { update_id: 9002, message: { chat: { id: 4242 }, text: "hello again" } };

      await Promise.all([
        handleTelegramWebhook(makeRequest(update), integration),
        handleTelegramWebhook(makeRequest(update), integration),
      ]);

      expect(mockAnswerExternalMessage).toHaveBeenCalledTimes(1);
    });

    it("a non-text update never reaches the gateway, verified against the real claim path too", async () => {
      const integration = await getTelegramIntegrationById(supabase, integrationId);
      if (!integration) throw new Error("integration not found");

      const stickerUpdate = { update_id: 9003, message: { chat: { id: 4242 }, sticker: { file_id: "abc" } } };
      await handleTelegramWebhook(makeRequest(stickerUpdate), integration);

      expect(mockAnswerExternalMessage).not.toHaveBeenCalled();
      // The update was still claimed (idempotency applies to non-text
      // updates too, see adapter.ts's own comment on claiming before
      // gating) -- confirms this isn't "ignored because never reached the
      // claim step" but "claimed, then correctly gated to ignore".
      const { data: claimed } = await supabase
        .from("channel_processed_updates")
        .select("update_id")
        .eq("integration_id", integrationId)
        .eq("update_id", 9003);
      expect(claimed).toHaveLength(1);
    });
  }
);
