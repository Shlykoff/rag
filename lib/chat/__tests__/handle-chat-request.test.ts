import { describe, expect, it, vi } from "vitest";
import { handleChatRequest, type ChatRequestInput, type ChatStreamEvent } from "../handle-chat-request";
import type { ChatProvider, ChatStreamResult, EmbeddingsProvider, TokenUsage } from "../../ai/types";
import { AIProviderError } from "../../ai/errors";
import type { MatchedChunk } from "../../retrieval/search";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Rejected placeholder for usage/text on a stream that fails before ever producing them -- see the equivalent helper/comment in lib/ai/__tests__/stream-utils.test.ts for why the eager .catch is needed. */
function neverConsumed<T = never>(message: string): Promise<T> {
  const rejected = Promise.reject(new Error(message)) as Promise<T>;
  rejected.catch(() => {});
  return rejected;
}

interface ConversationRow {
  id: string;
  user_id: string;
}

interface FakeConfig {
  /** Owner path: result of the `.eq("id",...).eq("project_id",...).eq("user_id",...)` lookup for a client-supplied conversationId. */
  conversation?: ConversationRow | null;
  /** Owner path: id assigned to a brand-new conversation row. */
  createdConversationId?: string;
  /**
   * External path: successive results of the `.select("id").match({project_id,channel,external_participant_id}).maybeSingle()`
   * lookup -- resolveExternalConversation() may call this up to twice (once
   * before the insert attempt, once more only if the insert hits a 23505
   * race). Defaults to `[null]` (not found) when omitted. The last entry
   * is reused for any call beyond the array's length.
   */
  externalConversationSequence?: ({ id: string } | null)[];
  /** External path: id assigned to a brand-new external-conversation row, when the insert succeeds. */
  createdExternalConversationId?: string;
  /** External path: simulates the insert itself failing (e.g. a real unique_violation race, code "23505", or any other DB error). */
  externalInsertError?: { message: string; code?: string } | null;
  history?: { role: "user" | "assistant"; content: string }[];
  matches?: MatchedChunk[];
  failInserts?: Partial<Record<"conversations" | "messages" | "usage_events", string>>;
}

function makeFakeSupabase(config: FakeConfig) {
  const inserted: { table: string; row: Record<string, unknown> }[] = [];
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  let externalSelectCallIndex = 0;

  function from(table: string) {
    if (table === "conversations") {
      let matchFilter: Record<string, unknown> | null = null;
      const builder = {
        select() {
          return builder;
        },
        eq() {
          // Only used by the owner-conversationId lookup chain
          // (.eq("id",...).eq("project_id",...).eq("user_id",...)) -- the
          // fake doesn't need to inspect individual filter args, it just
          // needs the chain to keep returning itself.
          return builder;
        },
        match(filter: Record<string, unknown>) {
          matchFilter = filter;
          return builder;
        },
        maybeSingle: async () => {
          if (matchFilter) {
            const sequence = config.externalConversationSequence ?? [null];
            const idx = Math.min(externalSelectCallIndex, sequence.length - 1);
            externalSelectCallIndex++;
            return { data: sequence[idx], error: null };
          }
          return { data: config.conversation ?? null, error: null };
        },
        insert: (row: Record<string, unknown>) => {
          inserted.push({ table, row });
          const isExternal = "channel" in row;
          return {
            select() {
              return this;
            },
            single: async () => {
              if (isExternal) {
                if (config.externalInsertError) {
                  return { data: null, error: config.externalInsertError };
                }
                return { data: { id: config.createdExternalConversationId ?? "new-external-conv-id" }, error: null };
              }
              if (config.failInserts?.conversations) {
                return { data: null, error: { message: config.failInserts.conversations } };
              }
              return { data: { id: config.createdConversationId ?? "new-conv-id" }, error: null };
            },
          };
        },
      };
      return builder;
    }
    if (table === "messages") {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        order: async () => ({ data: config.history ?? [], error: null }),
        insert: async (row: Record<string, unknown>) => {
          inserted.push({ table, row });
          if (config.failInserts?.messages) {
            return { error: { message: config.failInserts.messages } };
          }
          return { error: null };
        },
      };
    }
    if (table === "usage_events") {
      return {
        insert: async (row: Record<string, unknown>) => {
          inserted.push({ table, row });
          if (config.failInserts?.usage_events) {
            return { error: { message: config.failInserts.usage_events } };
          }
          return { error: null };
        },
      };
    }
    throw new Error(`makeFakeSupabase: unexpected table ${table}`);
  }

  const rpc = vi.fn().mockImplementation(async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    return { data: config.matches ?? [], error: null };
  });

  const supabase = { from, rpc } as unknown as SupabaseClient;
  return { supabase, inserted, rpcCalls };
}

function fakeEmbeddings(): EmbeddingsProvider {
  return {
    providerName: "fake-embed",
    modelName: "fake-embed-model",
    dimensions: 3,
    embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
  };
}

/** Per lib/ai/types.ts's EmbeddingsProvider contract, embed() always rejects with an already-normalized AIProviderError -- simulate a 429 exactly as a real provider adapter (lib/ai/embed-batch.ts) would surface it. */
function failingEmbeddings(): EmbeddingsProvider {
  return {
    providerName: "fake-embed",
    modelName: "fake-embed-model",
    dimensions: 3,
    embed: vi.fn().mockRejectedValue(
      new AIProviderError({
        provider: "fake-embed",
        kind: "rate_limited",
        retryable: true,
        message: "fake-embed API rate limited (429)",
        userMessage: "Сервис перегружен, попробуйте через несколько секунд.",
      })
    ),
  };
}

function fakeChatProvider(chunks: string[], usage = { promptTokens: 5, completionTokens: 5, totalTokens: 10 }): ChatProvider {
  return {
    providerName: "fake-chat",
    modelName: "fake-chat-model",
    streamChat: vi.fn().mockImplementation((): ChatStreamResult => {
      const textStream = (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
      return {
        textStream,
        usage: Promise.resolve(usage),
        text: Promise.resolve(chunks.join("")),
      };
    }),
  };
}

function failingChatProvider(): ChatProvider {
  return {
    providerName: "fake-chat",
    modelName: "fake-chat-model",
    streamChat: vi.fn().mockImplementation((): ChatStreamResult => {
      return {
        // A real ChatProvider (see lib/ai/stream-utils.ts) already
        // normalizes vendor errors into AIProviderError before they reach
        // callers -- simulate that here rather than throwing a plain
        // object, so this test exercises the same shape handleChatRequest
        // actually receives in production.
        textStream: (async function* () {
          throw new AIProviderError({
            provider: "fake-chat",
            kind: "server_error",
            retryable: false,
            message: "fake-chat API server error (503)",
            userMessage: "Сервис недоступен.",
          });
        })(),
        usage: neverConsumed("never"),
        text: neverConsumed("never"),
      };
    }),
  };
}

function matchedChunk(overrides: Partial<MatchedChunk> = {}): MatchedChunk {
  return {
    chunk_id: "chunk-1",
    document_id: "doc-1",
    content: "Relevant content.",
    chunk_index: 0,
    page_number: null,
    chunk_position: 0,
    similarity: 0.9,
    document_title: "Doc",
    document_source_type: "manual_upload",
    document_source_ref: null,
    ...overrides,
  };
}

async function collect(gen: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

const baseInput: ChatRequestInput = { projectId: "project-1", ownerUserId: "owner-1", message: "What is X?" };

describe("handleChatRequest", () => {
  it("creates a new conversation, retrieves context, streams the answer, and persists everything", async () => {
    const { supabase, inserted, rpcCalls } = makeFakeSupabase({
      createdConversationId: "conv-new",
      matches: [matchedChunk()],
    });
    const embeddingsProvider = fakeEmbeddings();
    const chatProvider = fakeChatProvider(["Hello", ", ", "world!"]);

    const events = await collect(
      handleChatRequest(baseInput, { supabase, chatProvider, embeddingsProvider })
    );

    expect(events[0]).toEqual({ type: "conversation", conversationId: "conv-new" });
    expect(events.find((e) => e.type === "sources")).toMatchObject({
      type: "sources",
      sources: [expect.objectContaining({ chunkId: "chunk-1" })],
    });
    const deltas = events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text);
    expect(deltas).toEqual(["Hello", ", ", "world!"]);
    expect(events[events.length - 1]).toEqual({
      type: "done",
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
    });

    // Retrieval RPC used the given projectId, never anything client-supplied.
    expect(rpcCalls[0].args.p_project_id).toBe("project-1");

    // New conversation is created with project_id + user_id = the owner.
    const conversationInsert = inserted.find((i) => i.table === "conversations");
    expect(conversationInsert?.row).toMatchObject({ project_id: "project-1", user_id: "owner-1" });

    // User message, assistant message, embedding usage, chat usage all persisted.
    expect(inserted.find((i) => i.table === "messages" && i.row.role === "user")).toBeTruthy();
    const assistantRow = inserted.find((i) => i.table === "messages" && i.row.role === "assistant");
    expect(assistantRow?.row.content).toBe("Hello, world!");
    expect(assistantRow?.row.sources).toEqual([expect.objectContaining({ chunkId: "chunk-1" })]);
    const embeddingUsage = inserted.find((i) => i.table === "usage_events" && i.row.event_type === "embedding_request");
    expect(embeddingUsage).toMatchObject({ row: { project_id: "project-1", user_id: "owner-1" } });
    const chatUsage = inserted.find((i) => i.table === "usage_events" && i.row.event_type === "chat_request");
    expect(chatUsage).toMatchObject({
      row: { project_id: "project-1", user_id: "owner-1", provider: "fake-chat", model: "fake-chat-model", total_tokens: 10 },
    });
  });

  it("reuses an existing conversation and includes prior history in the chat provider call", async () => {
    const { supabase } = makeFakeSupabase({
      conversation: { id: "conv-1", user_id: "owner-1" },
      history: [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
      ],
      matches: [],
    });
    const chatProvider = fakeChatProvider(["ok"]);
    await collect(
      handleChatRequest(
        { ...baseInput, conversationId: "conv-1" },
        { supabase, chatProvider, embeddingsProvider: fakeEmbeddings() }
      )
    );

    expect(chatProvider.streamChat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: "user", content: "Earlier question" },
          { role: "assistant", content: "Earlier answer" },
          { role: "user", content: "What is X?" },
        ],
      })
    );
  });

  it("yields an error and persists nothing when the conversation does not belong to the project/owner", async () => {
    const { supabase, inserted } = makeFakeSupabase({ conversation: null });
    const events = await collect(
      handleChatRequest(
        { ...baseInput, conversationId: "not-mine" },
        { supabase, chatProvider: fakeChatProvider(["x"]), embeddingsProvider: fakeEmbeddings() }
      )
    );
    expect(events).toEqual([{ type: "error", message: "Диалог не найден.", retryable: false }]);
    expect(inserted).toHaveLength(0);
  });

  it("yields an error immediately for an empty/whitespace-only message, with no DB calls", async () => {
    const { supabase, inserted, rpcCalls } = makeFakeSupabase({});
    const events = await collect(
      handleChatRequest(
        { ...baseInput, message: "   " },
        { supabase, chatProvider: fakeChatProvider(["x"]), embeddingsProvider: fakeEmbeddings() }
      )
    );
    expect(events).toEqual([{ type: "error", message: "Сообщение не может быть пустым.", retryable: false }]);
    expect(inserted).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);
  });

  it("yields an error event (not a thrown exception) when the chat provider fails mid-stream, without persisting an assistant message", async () => {
    const { supabase, inserted } = makeFakeSupabase({ createdConversationId: "conv-new", matches: [] });
    const events = await collect(
      handleChatRequest(baseInput, {
        supabase,
        chatProvider: failingChatProvider(),
        embeddingsProvider: fakeEmbeddings(),
      })
    );
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toMatchObject({ type: "error", message: "Сервис недоступен." });
    expect(inserted.find((i) => i.table === "messages" && i.row.role === "assistant")).toBeUndefined();
    expect(
      inserted.find((i) => i.table === "usage_events" && i.row.event_type === "chat_request")
    ).toBeUndefined();
    // The user's message and the retrieval's embedding usage should still
    // have been recorded before the provider failure.
    expect(inserted.find((i) => i.table === "messages" && i.row.role === "user")).toBeTruthy();
  });

  // Regression test for a bug qa-reviewer reproduced live (6 concurrent
  // real answerExternalMessage() calls against a real Gemini free-tier
  // 429, 5 of 6 threw a raw, unnormalized AI_NoOutputGeneratedError instead
  // of returning a graceful result): a completion that streams ZERO deltas
  // completes `stream.textStream` normally (no throw during iteration --
  // see lib/ai/stream-utils.ts's "empty-but-successful stream" branch), so
  // the OLD code's try/catch (which only wrapped the delta loop) never
  // fired -- the failure only surfaced when `stream.usage` was awaited
  // AFTER that try/catch, completely unguarded. Fixed by moving
  // `await stream.usage` INSIDE the same try -- this proves it stays
  // fixed: no exception escapes handleChatRequest, a single graceful
  // `type: "error"` event is yielded instead, and (same as the mid-stream
  // failure case above) no assistant message/usage_events row is persisted
  // for the failed turn.
  it("yields a graceful error event (not an uncaught exception) when the stream completes with ZERO deltas but its usage promise rejects afterward (e.g. a real AI_NoOutputGeneratedError)", async () => {
    const { supabase, inserted } = makeFakeSupabase({ createdConversationId: "conv-new", matches: [] });
    // Realistic shape: NoOutputGeneratedError extends AISDKError, which
    // carries whatever caused it (e.g. the underlying 429) as `.cause` --
    // see node_modules/ai/src/error/no-output-generated-error.ts.
    const zeroOutputError = Object.assign(new Error("No output generated."), {
      name: "AI_NoOutputGeneratedError",
      cause: new Error("rate limited (429)"),
    });
    // `usage` IS awaited by handleChatRequest (that's exactly what this
    // test proves is now handled) -- built directly rather than via the
    // `neverConsumed` helper below, but still eagerly `.catch(() => {})`ed
    // for the same reason `neverConsumed`/lib/ai/stream-utils.ts's own
    // `usage`/`text` do: calling `.catch()` only adds an independent
    // listener, it never mutates/replaces the promise, so
    // handleChatRequest's own real `await stream.usage` below still
    // observes the actual rejection unchanged -- this just stops Node's
    // unhandled-rejection tracking from complaining about the brief window
    // before that real `await` runs (several other awaits happen first:
    // the user-message insert, retrieval, the embedding-usage insert).
    const usage: Promise<TokenUsage> = (async () => {
      throw zeroOutputError;
    })();
    usage.catch(() => {});

    const zeroOutputChatProvider: ChatProvider = {
      providerName: "fake-chat",
      modelName: "fake-chat-model",
      streamChat: vi.fn().mockImplementation((): ChatStreamResult => ({
        // Yields NOTHING and completes without throwing -- this is the
        // exact shape that used to slip straight past the old try/catch.
        textStream: (async function* () {})(),
        usage,
        // `text` is never read by handleChatRequest at all on this path --
        // reuse the existing `neverConsumed` helper exactly as
        // `failingChatProvider()` above does, so it's marked handled
        // without needing its own ad-hoc dance.
        text: neverConsumed<string>("text is never read in this test"),
      })),
    };

    const events = await collect(
      handleChatRequest(baseInput, {
        supabase,
        chatProvider: zeroOutputChatProvider,
        embeddingsProvider: fakeEmbeddings(),
      })
    );

    // Exactly one graceful error event, nothing else after it (no `done`,
    // no thrown/uncaught exception propagating out of the async generator
    // -- `collect()` itself would have rejected if handleChatRequest threw
    // instead of yielding).
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent as { type: "error" }).type).toBe("error");
    expect(events[events.length - 1]).toBe(errorEvent);
    expect(events.find((e) => e.type === "done")).toBeUndefined();

    // Same "no partial persistence on a failed turn" contract as every
    // other failure path in this file.
    expect(inserted.find((i) => i.table === "messages" && i.row.role === "assistant")).toBeUndefined();
    expect(
      inserted.find((i) => i.table === "usage_events" && i.row.event_type === "chat_request")
    ).toBeUndefined();
    expect(inserted.find((i) => i.table === "messages" && i.row.role === "user")).toBeTruthy();
  });

  it("yields a graceful error event (preserving retryable/userMessage) when the embeddings provider fails during retrieval, instead of throwing", async () => {
    const { supabase, inserted, rpcCalls } = makeFakeSupabase({ createdConversationId: "conv-new" });
    const events = await collect(
      handleChatRequest(baseInput, {
        supabase,
        chatProvider: fakeChatProvider(["should never be reached"]),
        embeddingsProvider: failingEmbeddings(),
      })
    );
    // Same shape/handling as a chat-completion failure (Bug 3 fix): a
    // retryable AIProviderError from embeddingsProvider.embed() (inside
    // runRetrieval) must surface as a graceful `error` SSE event with its
    // real retryable/userMessage, not an uncaught throw that the route
    // handler would flatten into a hardcoded retryable: false.
    expect(events).toEqual([
      { type: "conversation", conversationId: "conv-new" },
      {
        type: "error",
        message: "Сервис перегружен, попробуйте через несколько секунд.",
        retryable: true,
      },
    ]);
    // Never got far enough to call the RPC or the chat provider.
    expect(rpcCalls).toHaveLength(0);
    expect(inserted.find((i) => i.table === "messages" && i.row.role === "assistant")).toBeUndefined();
    expect(inserted.find((i) => i.table === "usage_events")).toBeUndefined();
    // The user's own message is still persisted before retrieval runs.
    expect(inserted.find((i) => i.table === "messages" && i.row.role === "user")).toBeTruthy();
  });

  describe("external channel participant path", () => {
    const externalInput: ChatRequestInput = {
      projectId: "project-1",
      ownerUserId: "owner-1",
      message: "Hi bot",
      externalParticipant: { channel: "telegram", participantId: "tg-42" },
    };

    it("creates a brand-new conversation (select-miss -> insert) when this (project, channel, participant) has never messaged before", async () => {
      const { supabase, inserted } = makeFakeSupabase({
        externalConversationSequence: [null], // select finds nothing
        createdExternalConversationId: "external-conv-1",
        matches: [],
      });
      const events = await collect(
        handleChatRequest(externalInput, {
          supabase,
          chatProvider: fakeChatProvider(["ok"]),
          embeddingsProvider: fakeEmbeddings(),
        })
      );

      expect(events[0]).toEqual({ type: "conversation", conversationId: "external-conv-1" });
      const conversationInsert = inserted.find((i) => i.table === "conversations");
      expect(conversationInsert?.row).toEqual({
        project_id: "project-1",
        channel: "telegram",
        external_participant_id: "tg-42",
      });
    });

    it("reuses the existing conversation (select-hit, no insert) for a repeat message from the same participant", async () => {
      const { supabase, inserted } = makeFakeSupabase({
        externalConversationSequence: [{ id: "external-conv-1" }], // select finds the existing row
        matches: [],
      });
      const events = await collect(
        handleChatRequest(externalInput, {
          supabase,
          chatProvider: fakeChatProvider(["ok"]),
          embeddingsProvider: fakeEmbeddings(),
        })
      );

      expect(events[0]).toEqual({ type: "conversation", conversationId: "external-conv-1" });
      // No insert into conversations -- the select already found the row.
      expect(inserted.find((i) => i.table === "conversations")).toBeUndefined();
    });

    it("recovers via re-select when the insert loses a unique-violation race (23505) against a concurrent first message from the same participant", async () => {
      const { supabase, inserted } = makeFakeSupabase({
        // First select: not found yet. Insert: fails (23505, someone else
        // won the race). Second select: finds the winner's row.
        externalConversationSequence: [null, { id: "race-winner-conv" }],
        externalInsertError: { message: "duplicate key value violates unique constraint", code: "23505" },
        matches: [],
      });
      const events = await collect(
        handleChatRequest(externalInput, {
          supabase,
          chatProvider: fakeChatProvider(["ok"]),
          embeddingsProvider: fakeEmbeddings(),
        })
      );

      expect(events[0]).toEqual({ type: "conversation", conversationId: "race-winner-conv" });
      // The failed insert attempt is still recorded by the fake (it DID try),
      // but the flow recovered from it rather than surfacing an error.
      expect(events.find((e) => e.type === "error")).toBeUndefined();
      expect(inserted.filter((i) => i.table === "conversations")).toHaveLength(1);
    });

    it("yields a graceful error (not a thrown exception) when the insert fails for a reason OTHER than a 23505 race", async () => {
      const { supabase } = makeFakeSupabase({
        externalConversationSequence: [null],
        externalInsertError: { message: "connection reset" },
        matches: [],
      });
      const events = await collect(
        handleChatRequest(externalInput, {
          supabase,
          chatProvider: fakeChatProvider(["ok"]),
          embeddingsProvider: fakeEmbeddings(),
        })
      );
      expect(events).toEqual([
        { type: "error", message: "Не удалось найти или создать диалог: connection reset", retryable: false },
      ]);
    });

    it("usage_events.user_id is the project OWNER, not any external participant identifier, for the external path too", async () => {
      const { supabase, inserted } = makeFakeSupabase({
        externalConversationSequence: [{ id: "external-conv-1" }],
        matches: [],
      });
      await collect(
        handleChatRequest(externalInput, {
          supabase,
          chatProvider: fakeChatProvider(["ok"]),
          embeddingsProvider: fakeEmbeddings(),
        })
      );
      const chatUsage = inserted.find((i) => i.table === "usage_events" && i.row.event_type === "chat_request");
      expect(chatUsage?.row).toMatchObject({ project_id: "project-1", user_id: "owner-1" });
    });

    it("an externalParticipant input takes priority over (ignores) any stray conversationId", async () => {
      const { supabase, inserted } = makeFakeSupabase({
        externalConversationSequence: [{ id: "external-conv-1" }],
        matches: [],
      });
      await collect(
        handleChatRequest(
          { ...externalInput, conversationId: "should-be-ignored" },
          { supabase, chatProvider: fakeChatProvider(["ok"]), embeddingsProvider: fakeEmbeddings() }
        )
      );
      // No owner-path insert into conversations happened for this turn.
      expect(inserted.find((i) => i.table === "conversations")).toBeUndefined();
    });
  });
});
