// lib/gateway/__tests__/answer.test.ts
//
// Pure unit test for lib/gateway/answer.ts's OWN control flow -- every
// dependency (`lib/supabase/service-client`, `lib/ai`,
// `lib/chat/handle-chat-request`, `lib/rate-limit/rate-limiter`) is mocked,
// so this needs no Docker/Postgres (unlike
// lib/gateway/__tests__/answer.integration.test.ts, which deliberately
// exercises the REAL handleChatRequest against real Postgres). This file
// exists specifically to isolate and verify the defense-in-depth catch
// around the drain loop -- handleChatRequest is documented to never throw
// for a known failure mode (it yields a `type: "error"` event instead),
// but a live bug once already violated that contract (an
// AI_NoOutputGeneratedError from a zero-output completion escaped past
// handleChatRequest's own try/catch -- see that module's fix and
// answer.integration.test.ts's equivalent end-to-end regression test) --
// this proves answerExternalMessage's own "never throws" contract holds
// even if handleChatRequest's ever slips again.
//
// lib/rate-limit/channel-participant-rate-limiter.ts and
// lib/rate-limit/conversation-lock.ts are NOT mocked -- both are pure
// in-memory modules with no I/O, so using the real implementations (reset
// between tests via their own `__reset*ForTests` helpers) is simpler and
// more faithful than re-mocking synchronous logic that has nothing to do
// with what this file is testing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetChannelParticipantRateLimitForTests } from "../../rate-limit/channel-participant-rate-limiter";
import { __resetConversationLocksForTests } from "../../rate-limit/conversation-lock";

const mockGetServiceRoleClient = vi.fn();
const mockGetAIProviders = vi.fn();
const mockHandleChatRequest = vi.fn();
const mockReserveChatRateLimitSlot = vi.fn();

vi.mock("../../supabase/service-client", () => ({
  getServiceRoleClient: () => mockGetServiceRoleClient(),
}));

vi.mock("../../ai", async () => {
  const actual = await vi.importActual<typeof import("../../ai/errors")>("../../ai/errors");
  return {
    getAIProviders: (...args: unknown[]) => mockGetAIProviders(...args),
    AIProviderError: actual.AIProviderError,
  };
});

vi.mock("../../chat/handle-chat-request", () => ({
  handleChatRequest: (...args: unknown[]) => mockHandleChatRequest(...args),
}));

vi.mock("../../rate-limit/rate-limiter", () => ({
  reserveChatRateLimitSlot: (...args: unknown[]) => mockReserveChatRateLimitSlot(...args),
}));

// Static import after vi.mock is safe -- Vitest hoists vi.mock calls above imports.
import { answerExternalMessage } from "../answer";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "owner-1";

function fakeSupabase(project: { id: string; user_id: string } | null) {
  return {
    from(table: string) {
      if (table !== "projects") throw new Error(`fakeSupabase: unexpected table ${table}`);
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        maybeSingle: async () => ({ data: project, error: null }),
      };
    },
  };
}

const req = { projectId: PROJECT_ID, channel: "telegram", externalParticipantId: "tg-1", message: "hi" };

describe("answerExternalMessage (pure unit, all core deps mocked)", () => {
  beforeEach(() => {
    __resetChannelParticipantRateLimitForTests();
    __resetConversationLocksForTests();
    mockGetServiceRoleClient.mockReturnValue(fakeSupabase({ id: PROJECT_ID, user_id: OWNER_ID }));
    mockReserveChatRateLimitSlot.mockResolvedValue({ allowed: true, currentCount: 0, limit: 10, release: vi.fn() });
    mockGetAIProviders.mockResolvedValue({
      chatProvider: { providerName: "fake", modelName: "fake-model" },
      embeddingsProvider: { providerName: "fake", modelName: "fake-model", dimensions: 3, embed: vi.fn() },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // Defense-in-depth regression test: even if handleChatRequest itself
  // throws (violating its own documented "never throws for a known
  // failure mode" contract -- exactly what happened live with an
  // AI_NoOutputGeneratedError before the fix), answerExternalMessage must
  // still resolve to { kind: "error" }, never propagate the exception.
  it("returns { kind: 'error' } (never throws) when handleChatRequest itself throws instead of yielding a graceful error event", async () => {
    // Deliberately throws before ever yielding, simulating handleChatRequest's
    // documented-but-once-violated "never throws for a known failure mode"
    // contract being broken again.
    async function* throwingGenerator(): AsyncGenerator<never> {
      throw Object.assign(new Error("No output generated."), {
        name: "AI_NoOutputGeneratedError",
        cause: new Error("rate limited (429)"),
      });
    }
    mockHandleChatRequest.mockReturnValue(throwingGenerator());

    await expect(answerExternalMessage(req)).resolves.toEqual({ kind: "error" });
  });

  it("returns { kind: 'error' } (never throws) even if the exception is thrown mid-stream, after some deltas were already yielded", async () => {
    async function* partiallyThrowingGenerator(): AsyncGenerator<{ type: "delta"; text: string }> {
      yield { type: "delta", text: "partial answer" };
      throw new Error("connection reset mid-stream");
    }
    mockHandleChatRequest.mockReturnValue(partiallyThrowingGenerator());

    await expect(answerExternalMessage(req)).resolves.toEqual({ kind: "error" });
  });

  it("still returns { kind: 'ok' } on the ordinary success path (sanity check the mocks above are wired correctly)", async () => {
    async function* okGenerator() {
      yield { type: "conversation" as const, conversationId: "conv-1" };
      yield { type: "delta" as const, text: "Hello" };
      yield { type: "delta" as const, text: " world" };
      yield { type: "done" as const, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
    mockHandleChatRequest.mockReturnValue(okGenerator());

    await expect(answerExternalMessage(req)).resolves.toEqual({ kind: "ok", text: "Hello world" });
  });

  it("still returns { kind: 'error' } via the ordinary (non-defensive) path when handleChatRequest yields a graceful error event instead of throwing", async () => {
    async function* gracefulErrorGenerator() {
      yield { type: "conversation" as const, conversationId: "conv-1" };
      yield { type: "error" as const, message: "Сервис перегружен.", retryable: true };
    }
    mockHandleChatRequest.mockReturnValue(gracefulErrorGenerator());

    await expect(answerExternalMessage(req)).resolves.toEqual({ kind: "error" });
  });

  it("releases the conversation lock even when handleChatRequest throws (verified by a second call for the same participant succeeding right after)", async () => {
    async function* throwingGenerator(): AsyncGenerator<never> {
      throw new Error("boom");
    }
    mockHandleChatRequest.mockReturnValueOnce(throwingGenerator());
    const first = await answerExternalMessage(req);
    expect(first).toEqual({ kind: "error" });

    async function* okGenerator() {
      yield { type: "done" as const, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
    mockHandleChatRequest.mockReturnValueOnce(okGenerator());
    const second = await answerExternalMessage(req);
    // If the lock had leaked (not released in the `finally` after the
    // first call's exception), this second call for the SAME participant
    // would come back `rate_limited` instead.
    expect(second).toEqual({ kind: "ok", text: "" });
  });
});
