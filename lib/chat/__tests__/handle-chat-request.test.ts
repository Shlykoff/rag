import { describe, expect, it, vi } from "vitest";
import { handleChatRequest, type ChatRequestInput, type ChatStreamEvent } from "../handle-chat-request";
import type { ChatProvider, ChatStreamResult, EmbeddingsProvider } from "../../ai/types";
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
  conversation?: ConversationRow | null;
  createdConversationId?: string;
  history?: { role: "user" | "assistant"; content: string }[];
  matches?: MatchedChunk[];
  failInserts?: Partial<Record<"conversations" | "messages" | "usage_events", string>>;
}

function makeFakeSupabase(config: FakeConfig) {
  const inserted: { table: string; row: Record<string, unknown> }[] = [];
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];

  function from(table: string) {
    if (table === "conversations") {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        maybeSingle: async () => ({ data: config.conversation ?? null, error: null }),
        insert: (row: Record<string, unknown>) => {
          inserted.push({ table, row });
          return {
            select() {
              return this;
            },
            single: async () => {
              if (config.failInserts?.conversations) {
                return { data: null, error: { message: config.failInserts.conversations } };
              }
              return { data: { id: config.createdConversationId ?? "new-conv-id" }, error: null };
            },
          };
        },
      };
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

const baseInput: ChatRequestInput = { userId: "user-1", message: "What is X?" };

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

    // Retrieval RPC used the server-validated userId, never anything client-supplied.
    expect(rpcCalls[0].args.p_user_id).toBe("user-1");

    // User message, assistant message, embedding usage, chat usage all persisted.
    expect(inserted.find((i) => i.table === "messages" && i.row.role === "user")).toBeTruthy();
    const assistantRow = inserted.find((i) => i.table === "messages" && i.row.role === "assistant");
    expect(assistantRow?.row.content).toBe("Hello, world!");
    expect(assistantRow?.row.sources).toEqual([expect.objectContaining({ chunkId: "chunk-1" })]);
    expect(inserted.find((i) => i.table === "usage_events" && i.row.event_type === "embedding_request")).toBeTruthy();
    expect(
      inserted.find((i) => i.table === "usage_events" && i.row.event_type === "chat_request")
    ).toMatchObject({ row: { provider: "fake-chat", model: "fake-chat-model", total_tokens: 10 } });
  });

  it("reuses an existing conversation and includes prior history in the chat provider call", async () => {
    const { supabase } = makeFakeSupabase({
      conversation: { id: "conv-1", user_id: "user-1" },
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

  it("yields an error and persists nothing when the conversation does not belong to the user", async () => {
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
});
