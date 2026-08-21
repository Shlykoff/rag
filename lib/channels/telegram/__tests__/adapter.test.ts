// lib/channels/telegram/__tests__/adapter.test.ts
//
// Unit tests for the Telegram adapter's own control flow, against mocked
// dependencies: `../../gateway/answer` (the one allowed core-app import --
// mocked here purely as a test boundary, not a production import
// violation, see lib/gateway/__tests__/answer.integration.test.ts for the
// real thing), `../client` (outbound sendMessage calls), and
// `../../supabase/service-client` (the channel_processed_updates claim +
// the /new conversation reset). No real Telegram account or real Postgres
// needed for any of this.

import { afterEach, describe, expect, it, vi } from "vitest";

const mockAnswerExternalMessage = vi.fn();
const mockSendTelegramMessage = vi.fn();
const mockGetServiceRoleClient = vi.fn();

vi.mock("../../../gateway/answer", () => ({
  answerExternalMessage: (...args: unknown[]) => mockAnswerExternalMessage(...args),
}));

vi.mock("../client", () => ({
  sendTelegramMessage: (...args: unknown[]) => mockSendTelegramMessage(...args),
}));

vi.mock("../../../supabase/service-client", () => ({
  getServiceRoleClient: () => mockGetServiceRoleClient(),
}));

import { handleTelegramWebhook, telegramChannelAdapter } from "../adapter";
import type { ChannelIntegrationConfig } from "../../types";

const WEBHOOK_SECRET = "test-webhook-secret-value";
const INTEGRATION: ChannelIntegrationConfig = {
  id: "integration-1",
  projectId: "project-1",
  channel: "telegram",
  credentials: { botToken: "123:fake-bot-token", webhookSecret: WEBHOOK_SECRET },
};

function makeRequest(body: unknown, secret: string | null = WEBHOOK_SECRET): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  return new Request("http://localhost/api/channels/telegram/integration-1", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** Fake Supabase client covering exactly the two tables the adapter touches: channel_processed_updates (claim) and conversations (/new reset). Configurable per test via `alreadyClaimed`. */
function makeFakeSupabase(options: { alreadyClaimed?: boolean } = {}) {
  const deletedConversationFilters: Record<string, unknown>[] = [];
  const claimedUpdateIds: number[] = [];

  const supabase = {
    from(table: string) {
      if (table === "channel_processed_updates") {
        return {
          upsert: (row: { update_id: number }) => {
            claimedUpdateIds.push(row.update_id);
            return {
              select: () => ({
                then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
                  resolve({ data: options.alreadyClaimed ? [] : [{ integration_id: "integration-1" }], error: null }),
              }),
            };
          },
        };
      }
      if (table === "conversations") {
        const filters: Record<string, unknown> = {};
        const builder = {
          delete: () => builder,
          eq(col: string, val: unknown) {
            filters[col] = val;
            return builder;
          },
          then: (resolve: (v: { error: null }) => void) => {
            deletedConversationFilters.push({ ...filters });
            resolve({ error: null });
          },
        };
        return builder;
      }
      throw new Error(`makeFakeSupabase: unexpected table ${table}`);
    },
  };

  return { supabase, deletedConversationFilters, claimedUpdateIds };
}

function textUpdate(text: string, updateId = 1, chatId: number | string = 555): unknown {
  return { update_id: updateId, message: { chat: { id: chatId }, text } };
}

describe("telegram adapter: parseIncoming / handleTelegramWebhook", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a request with a missing webhook secret header -- never claims the update or calls the gateway", async () => {
    const { supabase } = makeFakeSupabase();
    mockGetServiceRoleClient.mockReturnValue(supabase);

    await handleTelegramWebhook(makeRequest(textUpdate("hello"), null), INTEGRATION);

    expect(mockAnswerExternalMessage).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("rejects a request with the WRONG webhook secret -- never claims the update or calls the gateway", async () => {
    const { supabase } = makeFakeSupabase();
    mockGetServiceRoleClient.mockReturnValue(supabase);

    await handleTelegramWebhook(makeRequest(textUpdate("hello"), "wrong-secret"), INTEGRATION);

    expect(mockAnswerExternalMessage).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("a duplicate update_id (already claimed) is ignored -- never reaches the gateway", async () => {
    const { supabase, claimedUpdateIds } = makeFakeSupabase({ alreadyClaimed: true });
    mockGetServiceRoleClient.mockReturnValue(supabase);

    await handleTelegramWebhook(makeRequest(textUpdate("hello", 42)), INTEGRATION);

    expect(claimedUpdateIds).toEqual([42]); // the claim attempt still happened
    expect(mockAnswerExternalMessage).not.toHaveBeenCalled(); // but processing never proceeded
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("a non-text update (photo, no .text field) is ignored -- never reaches the gateway", async () => {
    const { supabase } = makeFakeSupabase();
    mockGetServiceRoleClient.mockReturnValue(supabase);

    const photoUpdate = { update_id: 2, message: { chat: { id: 555 }, photo: [{ file_id: "abc" }] } };
    await handleTelegramWebhook(makeRequest(photoUpdate), INTEGRATION);

    expect(mockAnswerExternalMessage).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it("a sticker update is ignored -- never reaches the gateway", async () => {
    const { supabase } = makeFakeSupabase();
    mockGetServiceRoleClient.mockReturnValue(supabase);

    const stickerUpdate = { update_id: 3, message: { chat: { id: 555 }, sticker: { file_id: "xyz" } } };
    await handleTelegramWebhook(makeRequest(stickerUpdate), INTEGRATION);

    expect(mockAnswerExternalMessage).not.toHaveBeenCalled();
  });

  it("an edited_message-only update (no top-level .message at all) is ignored -- never reaches the gateway", async () => {
    const { supabase } = makeFakeSupabase();
    mockGetServiceRoleClient.mockReturnValue(supabase);

    const editedUpdate = { update_id: 4, edited_message: { chat: { id: 555 }, text: "edited text" } };
    await handleTelegramWebhook(makeRequest(editedUpdate), INTEGRATION);

    expect(mockAnswerExternalMessage).not.toHaveBeenCalled();
  });

  it("a my_chat_member-only update is ignored -- never reaches the gateway", async () => {
    const { supabase } = makeFakeSupabase();
    mockGetServiceRoleClient.mockReturnValue(supabase);

    const memberUpdate = { update_id: 5, my_chat_member: { chat: { id: 555 } } };
    await handleTelegramWebhook(makeRequest(memberUpdate), INTEGRATION);

    expect(mockAnswerExternalMessage).not.toHaveBeenCalled();
  });

  it("a malformed JSON body is ignored, not treated as unauthorized", async () => {
    const { supabase } = makeFakeSupabase();
    mockGetServiceRoleClient.mockReturnValue(supabase);

    const badRequest = new Request("http://localhost/api/channels/telegram/integration-1", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET },
      body: "{not valid json",
    });
    await handleTelegramWebhook(badRequest, INTEGRATION);
    expect(mockAnswerExternalMessage).not.toHaveBeenCalled();
  });

  it("/start sends the onboarding message and never calls the gateway", async () => {
    const { supabase } = makeFakeSupabase();
    mockGetServiceRoleClient.mockReturnValue(supabase);

    await handleTelegramWebhook(makeRequest(textUpdate("/start")), INTEGRATION);

    expect(mockAnswerExternalMessage).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(mockSendTelegramMessage).toHaveBeenCalledWith("123:fake-bot-token", "555", expect.stringContaining("ассистент"));
  });

  it("/start@SomeBotName (group-chat-style suffix) is still recognized as the /start command", async () => {
    const { supabase } = makeFakeSupabase();
    mockGetServiceRoleClient.mockReturnValue(supabase);

    await handleTelegramWebhook(makeRequest(textUpdate("/start@MyRagBot")), INTEGRATION);

    expect(mockAnswerExternalMessage).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("/new resets the conversation (deletes the matching conversations row) and replies statically, without calling the gateway", async () => {
    const { supabase, deletedConversationFilters } = makeFakeSupabase();
    mockGetServiceRoleClient.mockReturnValue(supabase);

    await handleTelegramWebhook(makeRequest(textUpdate("/new", 10, 999)), INTEGRATION);

    expect(mockAnswerExternalMessage).not.toHaveBeenCalled();
    expect(deletedConversationFilters).toEqual([
      { project_id: "project-1", channel: "telegram", external_participant_id: "999" },
    ]);
    expect(mockSendTelegramMessage).toHaveBeenCalledWith("123:fake-bot-token", "999", expect.stringContaining("Начинаем"));
  });

  it("a normal text message calls the gateway with the right shape and replies with its 'ok' text", async () => {
    const { supabase } = makeFakeSupabase();
    mockGetServiceRoleClient.mockReturnValue(supabase);
    mockAnswerExternalMessage.mockResolvedValue({ kind: "ok", text: "The answer is 42." });

    await handleTelegramWebhook(makeRequest(textUpdate("What is the answer?", 20, 777)), INTEGRATION);

    expect(mockAnswerExternalMessage).toHaveBeenCalledWith({
      projectId: "project-1",
      channel: "telegram",
      externalParticipantId: "777",
      message: "What is the answer?",
    });
    expect(mockSendTelegramMessage).toHaveBeenCalledWith("123:fake-bot-token", "777", "The answer is 42.");
  });

  it.each([
    ["rate_limited", { kind: "rate_limited" as const }],
    ["no_credentials", { kind: "no_credentials" as const }],
    ["error", { kind: "error" as const }],
  ])("gateway result kind '%s' still sends SOME reply, and it never mentions document/context/источник", async (_label, result) => {
    const { supabase } = makeFakeSupabase();
    mockGetServiceRoleClient.mockReturnValue(supabase);
    mockAnswerExternalMessage.mockResolvedValue(result);

    await handleTelegramWebhook(makeRequest(textUpdate("hi", 30, 111)), INTEGRATION);

    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(1);
    const [, , replyText] = mockSendTelegramMessage.mock.calls[0] as [string, string, string];
    expect(replyText.length).toBeGreaterThan(0);
    expect(replyText.toLowerCase()).not.toMatch(/document|context|источник|контекст/);
  });

  it("a failed outbound send (sendTelegramMessage throws) is swallowed -- handleTelegramWebhook never throws", async () => {
    const { supabase } = makeFakeSupabase();
    mockGetServiceRoleClient.mockReturnValue(supabase);
    mockAnswerExternalMessage.mockResolvedValue({ kind: "ok", text: "hi" });
    mockSendTelegramMessage.mockRejectedValue(new Error("Telegram API down"));

    await expect(handleTelegramWebhook(makeRequest(textUpdate("hi", 40, 222)), INTEGRATION)).resolves.toBeUndefined();
  });

  it("telegramChannelAdapter.channel is 'telegram' (registry key contract)", () => {
    expect(telegramChannelAdapter.channel).toBe("telegram");
  });
});
