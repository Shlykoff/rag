// lib/gateway/__tests__/answer.integration.test.ts
//
// Runs against a REAL local Supabase (see README "Running the integration
// tests" / `npm run test:integration`) -- real `projects`/`conversations`/
// `messages`/`usage_events` rows, real match_document_chunks RPC calls,
// real reserveChatRateLimitSlot() DB counting. `lib/ai`'s getAIProviders()
// is mocked (same "mock the one module-level dependency, exercise this
// file's own control flow" pattern already used by
// lib/ingestion/__tests__/ingest-default-providers.test.ts) so this suite
// never needs a real AI-provider API key -- no real Telegram account is
// needed either, since this calls answerExternalMessage() directly with
// constructed ChannelAdapter-shaped inputs, never lib/channels/ at all.
//
// Every test creates its OWN fresh project (lib/testing/integration-helpers.ts's
// createTestProject()) rather than sharing one across the file: usage_events
// is append-only with no UPDATE/DELETE grant even for service_role (see
// that table's migration), so there is no way to reset a project's
// layer-1 rate-limit history between tests -- a fresh project per test is
// what makes exact-count assertions (layer 1's aggregate limit tests
// especially) reliable rather than order-dependent on whatever earlier
// tests in this file happened to insert.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AIProviderError } from "../../ai/errors";
import {
  createTestProject,
  createTestUser,
  deleteTestUser,
  deterministicVector,
  hasIntegrationEnv,
  makeIntegrationSupabaseClient,
} from "../../testing/integration-helpers";
import { __resetRateLimitReservationsForTests, DEFAULT_CHAT_RATE_LIMIT } from "../../rate-limit/rate-limiter";
import {
  __resetChannelParticipantRateLimitForTests,
  DEFAULT_CHANNEL_PARTICIPANT_RATE_LIMIT,
} from "../../rate-limit/channel-participant-rate-limiter";
import {
  acquireConversationLock,
  releaseConversationLock,
  __resetConversationLocksForTests,
} from "../../rate-limit/conversation-lock";

const mockGetAIProviders = vi.fn();

vi.mock("../../ai", async () => {
  const actual = await vi.importActual<typeof import("../../ai/errors")>("../../ai/errors");
  return {
    getAIProviders: (...args: unknown[]) => mockGetAIProviders(...args),
    AIProviderError: actual.AIProviderError,
  };
});

// Static import after vi.mock is safe -- Vitest hoists vi.mock calls above
// imports, same pattern as app/api/chat/__tests__/route.test.ts.
import { answerExternalMessage } from "../answer";

interface FakeChatProviderOptions {
  chunks: string[];
  /** Lets a test hold the stream open until it explicitly resolves this, to simulate an in-flight turn for lock/concurrency tests. */
  waitFor?: Promise<void>;
}

function fakeChatProvider({ chunks, waitFor }: FakeChatProviderOptions) {
  return {
    providerName: "fake-chat",
    modelName: "fake-chat-model",
    streamChat: () => ({
      textStream: (async function* () {
        if (waitFor) await waitFor;
        for (const chunk of chunks) yield chunk;
      })(),
      usage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
      text: Promise.resolve(chunks.join("")),
    }),
  };
}

// Real dimensionality (1024, matching document_chunks.embedding
// vector(1024)) and a FIXED, deterministic vector (see
// lib/testing/integration-helpers.ts's deterministicVector) -- every
// beforeEach below inserts a real document_chunks row with this EXACT SAME
// vector, so cosine similarity between the query embedding and that stored
// chunk is always 1.0 (identical vectors), comfortably clearing
// lib/chat/handle-chat-request.ts's anti-hallucination
// MIN_RELEVANT_SIMILARITY guard. Without this, every test project in this
// file (freshly created per test, with zero real documents) would return
// zero matches from the real match_document_chunks RPC and trip that guard
// for every single test -- these tests are about gateway-level
// concurrency/rate-limiting/error-handling, not retrieval quality, so
// making retrieval reliably succeed is what keeps them testing what
// they're actually about.
const RELEVANT_CHUNK_SEED = 0;

function fakeEmbeddingsProvider() {
  return {
    providerName: "fake-embed",
    modelName: "fake-embed-model",
    dimensions: 1024,
    embed: async (texts: string[]) => texts.map(() => deterministicVector(RELEVANT_CHUNK_SEED)),
  };
}

function fakeProviders(chunks: string[], waitFor?: Promise<void>) {
  return { chatProvider: fakeChatProvider({ chunks, waitFor }), embeddingsProvider: fakeEmbeddingsProvider() };
}

describe.skipIf(!hasIntegrationEnv())("answerExternalMessage (integration, real Supabase)", () => {
  let supabase: SupabaseClient;
  let userId: string;
  let projectId: string;

  beforeAll(async () => {
    supabase = makeIntegrationSupabaseClient();
    const user = await createTestUser(supabase, "gateway-answer");
    userId = user.id;
  });

  afterAll(async () => {
    if (userId) await deleteTestUser(supabase, userId);
  });

  beforeEach(async () => {
    mockGetAIProviders.mockReset();
    __resetRateLimitReservationsForTests();
    __resetChannelParticipantRateLimitForTests();
    __resetConversationLocksForTests();
    // Fresh project per test -- see module header for why.
    projectId = (await createTestProject(supabase, userId)).id;

    // A real, relevant document + chunk so retrieval finds SOMETHING for
    // every test's query embedding to match against -- see
    // fakeEmbeddingsProvider()'s own comment for why this is required now
    // that lib/chat/handle-chat-request.ts short-circuits (skips the LLM
    // entirely) when nothing relevant is retrieved.
    const { data: doc, error: docError } = await supabase
      .from("documents")
      .insert({ project_id: projectId, title: "Gateway test doc", source_type: "manual_upload", processing_status: "ready" })
      .select("id")
      .single();
    if (docError) throw new Error(`beforeEach: failed to insert test document: ${docError.message}`);
    const { error: chunkError } = await supabase.from("document_chunks").insert({
      document_id: doc.id,
      chunk_index: 0,
      content: "Relevant content for gateway integration tests.",
      embedding: deterministicVector(RELEVANT_CHUNK_SEED),
      embedding_provider: "fake-embed",
      embedding_model: "fake-embed-model",
    });
    if (chunkError) throw new Error(`beforeEach: failed to insert test chunk: ${chunkError.message}`);
  });

  it("happy path: answers, persists an external-shaped conversation + both messages, and returns { kind: 'ok', text }", async () => {
    mockGetAIProviders.mockResolvedValue(fakeProviders(["Hello", " there"]));

    const result = await answerExternalMessage({
      projectId,
      channel: "telegram",
      externalParticipantId: "tg-happy-path",
      message: "Hi",
    });

    expect(result).toEqual({ kind: "ok", text: "Hello there" });
    // preFetchedProjectRow is now included -- answerExternalMessage() passes
    // through the exact {id, user_id} row it already fetched to resolve
    // ownerUserId, so getAIProviders() can skip its own redundant re-fetch
    // of the identical row (see lib/ai/index.ts's GetAIProvidersParams doc
    // comment).
    expect(mockGetAIProviders).toHaveBeenCalledWith(
      { projectId, ownerUserId: userId, preFetchedProjectRow: { id: projectId, user_id: userId } },
      expect.anything()
    );

    const { data: conv, error: convError } = await supabase
      .from("conversations")
      .select("id, user_id, channel, external_participant_id")
      .eq("project_id", projectId)
      .eq("channel", "telegram")
      .eq("external_participant_id", "tg-happy-path")
      .single();
    if (convError) throw new Error(convError.message);
    expect(conv.user_id).toBeNull(); // external-shaped conversation, per the conversations_exactly_one_owner_shape check

    const { data: msgs, error: msgsError } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conv.id)
      .order("created_at", { ascending: true });
    if (msgsError) throw new Error(msgsError.message);
    expect(msgs).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello there" },
    ]);
  });

  // Regression test for the exact scenario qa-reviewer reproduced live
  // against a real Gemini free-tier 429 (6 concurrent real
  // answerExternalMessage() calls, 5 of 6 threw a raw, unnormalized
  // AI_NoOutputGeneratedError instead of returning a graceful result).
  // Unlike the other tests in this file, `handleChatRequest` itself is
  // NOT mocked here -- this deliberately exercises the REAL (now fixed)
  // lib/chat/handle-chat-request.ts, so this is true end-to-end coverage
  // of the fix on the Telegram-gateway path specifically. See
  // lib/chat/__tests__/handle-chat-request.test.ts for the equivalent
  // direct unit test of the underlying fix itself, and
  // lib/gateway/__tests__/answer.test.ts (pure unit, handleChatRequest
  // mocked) for the separate defense-in-depth catch this bug also
  // motivated, tested in isolation.
  it("returns { kind: 'error' } (never throws) when the completion streams ZERO deltas and its usage promise rejects afterward (e.g. AI_NoOutputGeneratedError)", async () => {
    const zeroOutputError = Object.assign(new Error("No output generated."), {
      name: "AI_NoOutputGeneratedError",
      cause: new Error("rate limited (429)"),
    });
    const usage = (async () => {
      throw zeroOutputError;
    })();
    usage.catch(() => {}); // mark handled -- handleChatRequest's own real await still observes the rejection, see the equivalent comment in handle-chat-request.test.ts
    const text = (async () => {
      throw zeroOutputError;
    })();
    text.catch(() => {}); // never actually read by handleChatRequest on this path

    mockGetAIProviders.mockResolvedValue({
      chatProvider: {
        providerName: "fake-chat",
        modelName: "fake-chat-model",
        streamChat: () => ({
          textStream: (async function* () {})(), // zero deltas, completes without throwing
          usage,
          text,
        }),
      },
      embeddingsProvider: fakeEmbeddingsProvider(),
    });

    const result = await answerExternalMessage({
      projectId,
      channel: "telegram",
      externalParticipantId: "tg-zero-output",
      message: "Hi",
    });

    expect(result).toEqual({ kind: "error" });
  });

  it("returns { kind: 'no_credentials' } when getAIProviders() rejects with AIProviderError{kind:'no_credentials'}", async () => {
    mockGetAIProviders.mockRejectedValue(
      new AIProviderError({
        provider: "none",
        kind: "no_credentials",
        retryable: false,
        message: "no credentials",
        userMessage: "no credentials",
      })
    );

    const result = await answerExternalMessage({
      projectId,
      channel: "telegram",
      externalParticipantId: "tg-no-creds",
      message: "Hi",
    });
    expect(result).toEqual({ kind: "no_credentials" });
  });

  it("returns { kind: 'error' } for an unexpected getAIProviders() failure (not the no_credentials special case)", async () => {
    mockGetAIProviders.mockRejectedValue(new Error("db exploded"));

    const result = await answerExternalMessage({
      projectId,
      channel: "telegram",
      externalParticipantId: "tg-real-error",
      message: "Hi",
    });
    expect(result).toEqual({ kind: "error" });
  });

  it("returns { kind: 'error' } (never throws) when the project does not exist, without ever calling getAIProviders", async () => {
    const result = await answerExternalMessage({
      projectId: "00000000-0000-0000-0000-000000000000",
      channel: "telegram",
      externalParticipantId: "tg-ghost-project",
      message: "Hi",
    });
    expect(result).toEqual({ kind: "error" });
    expect(mockGetAIProviders).not.toHaveBeenCalled();
  });

  // These three lock tests set up the "a previous turn is still in
  // flight" state DETERMINISTICALLY, by calling acquireConversationLock()
  // directly, rather than racing two real concurrent answerExternalMessage()
  // calls against a fixed setTimeout window. A timing-based version of
  // this test was tried first and found genuinely flaky under full-suite
  // load (many DB round-trips ahead of the lock acquisition point can push
  // "the first call" past "the second call" in wall-clock terms even
  // though it was issued first) -- worse, with mockResolvedValueOnce
  // sequencing keyed to CALL ORDER rather than to which logical
  // participant the call was "for", a reordering like that could make the
  // wrong call receive the blocking provider and deadlock the test
  // waiting on a `release` that only fires after the OTHER call resolves.
  // The direct-lock-manipulation version below is fully deterministic and
  // tests the exact same real code path in lib/gateway/answer.ts (its own
  // internal `acquireConversationLock` call simply returns false, exactly
  // as it would for a genuinely concurrent duplicate delivery).

  it("layer 3 (conversation lock): rejects an overlapping message from a participant whose previous turn is still locked, without ever calling the AI provider", async () => {
    mockGetAIProviders.mockResolvedValue(fakeProviders(["should never be reached"]));
    const acquired = acquireConversationLock(projectId, "telegram", "tg-lock-test");
    expect(acquired).toBe(true);
    try {
      const result = await answerExternalMessage({
        projectId,
        channel: "telegram",
        externalParticipantId: "tg-lock-test",
        message: "overlapping message",
      });
      expect(result).toEqual({ kind: "rate_limited" });
      expect(mockGetAIProviders).not.toHaveBeenCalled();
    } finally {
      releaseConversationLock(projectId, "telegram", "tg-lock-test");
    }
  });

  it("releasing the lock lets the next message through -- confirms the lock itself (not something else) is what rejected the previous case", async () => {
    mockGetAIProviders.mockResolvedValue(fakeProviders(["ok"]));
    acquireConversationLock(projectId, "telegram", "tg-lock-release-test");

    const blocked = await answerExternalMessage({
      projectId,
      channel: "telegram",
      externalParticipantId: "tg-lock-release-test",
      message: "first",
    });
    expect(blocked).toEqual({ kind: "rate_limited" });

    releaseConversationLock(projectId, "telegram", "tg-lock-release-test");

    const allowed = await answerExternalMessage({
      projectId,
      channel: "telegram",
      externalParticipantId: "tg-lock-release-test",
      message: "second",
    });
    expect(allowed).toEqual({ kind: "ok", text: "ok" });
  });

  it("two different participants never block each other via the conversation lock", async () => {
    mockGetAIProviders.mockResolvedValue(fakeProviders(["ok for b"]));
    // Simulate participant A's turn already being in flight.
    acquireConversationLock(projectId, "telegram", "tg-a");
    try {
      const resultForB = await answerExternalMessage({
        projectId,
        channel: "telegram",
        externalParticipantId: "tg-b",
        message: "hi",
      });
      expect(resultForB).toEqual({ kind: "ok", text: "ok for b" });
    } finally {
      releaseConversationLock(projectId, "telegram", "tg-a");
    }
  });

  it("layer 2 (per-participant): one participant hitting their own tighter limit is rejected, independent of the project's still-unused aggregate budget", async () => {
    mockGetAIProviders.mockResolvedValue(fakeProviders(["ok"]));
    expect(DEFAULT_CHANNEL_PARTICIPANT_RATE_LIMIT.maxRequests).toBeLessThan(DEFAULT_CHAT_RATE_LIMIT.maxRequests);

    const results = [];
    for (let i = 0; i < DEFAULT_CHANNEL_PARTICIPANT_RATE_LIMIT.maxRequests + 1; i++) {
      results.push(
        await answerExternalMessage({ projectId, channel: "telegram", externalParticipantId: "tg-spammer", message: `msg ${i}` })
      );
    }
    const okCount = DEFAULT_CHANNEL_PARTICIPANT_RATE_LIMIT.maxRequests;
    expect(results.slice(0, okCount).every((r) => r.kind === "ok")).toBe(true);
    expect(results[okCount]).toEqual({ kind: "rate_limited" });
  });

  it("layer 1 (per-project aggregate): genuinely SHARED across many different external participants of the same project, not isolated per participant", async () => {
    mockGetAIProviders.mockResolvedValue(fakeProviders(["ok"]));
    // One message per participant (well under layer 2's per-participant
    // limit) so ONLY layer 1's shared project-wide budget can be what
    // eventually rejects a request.
    const limit = DEFAULT_CHAT_RATE_LIMIT.maxRequests;
    for (let i = 0; i < limit; i++) {
      const result = await answerExternalMessage({
        projectId,
        channel: "telegram",
        externalParticipantId: `tg-shared-${i}`,
        message: "hi",
      });
      expect(result.kind).toBe("ok");
    }
    const oneMore = await answerExternalMessage({
      projectId,
      channel: "telegram",
      externalParticipantId: `tg-shared-${limit}`, // a brand-new participant, never sent a message before
      message: "hi",
    });
    expect(oneMore).toEqual({ kind: "rate_limited" });
  });
});
