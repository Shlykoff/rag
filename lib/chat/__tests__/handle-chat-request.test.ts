import { describe, expect, it, vi } from "vitest";
import { handleChatRequest, type ChatRequestInput, type ChatStreamEvent } from "../handle-chat-request";
import type { ChatProvider, ChatStreamResult, EmbeddingsProvider, TokenUsage } from "../../ai/types";
import { AIProviderError } from "../../ai/errors";
import type { MatchedChunk } from "../../retrieval/search";
import { checkChatRateLimit, DEFAULT_CHAT_RATE_LIMIT } from "../../rate-limit/rate-limiter";
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
  const historyLimitCalls: number[] = [];
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
        // fetchHistory now queries most-recent-first + LIMIT (see
        // handle-chat-request.ts's MAX_HISTORY_MESSAGES) then reverses back
        // to chronological order itself -- this fake always hands back
        // `config.history` verbatim (already in the order tests construct
        // it), consistent with a `.order(desc).limit(n)` call whose result
        // handleChatRequest then re-reverses to exactly `config.history`'s
        // order when tests provide history already oldest-first.
        order() {
          return this;
        },
        limit: async (n: number) => {
          historyLimitCalls.push(n);
          return { data: [...(config.history ?? [])].reverse(), error: null };
        },
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
  return { supabase, inserted, rpcCalls, historyLimitCalls };
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
      // A relevant match -- NOT `[]` -- so this test actually exercises the
      // chat-provider-calling path it's named for, rather than incidentally
      // triggering the anti-hallucination short-circuit (see
      // hasRelevantContext() in handle-chat-request.ts), which never calls
      // the chat provider at all.
      matches: [matchedChunk()],
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

  // Regression test for Bug 6: fetchHistory used to have no LIMIT at all --
  // this asserts handleChatRequest actually bounds the query (via
  // MAX_HISTORY_MESSAGES), and that the result handed to the chat provider
  // is still in correct chronological (oldest-first) order after the
  // query's own most-recent-first ordering is reversed back.
  it("bounds how much prior history is fetched (a LIMIT is applied to the messages query)", async () => {
    const { supabase, historyLimitCalls } = makeFakeSupabase({
      conversation: { id: "conv-1", user_id: "owner-1" },
      history: [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
      ],
      matches: [matchedChunk()],
    });
    const chatProvider = fakeChatProvider(["ok"]);
    await collect(
      handleChatRequest(
        { ...baseInput, conversationId: "conv-1" },
        { supabase, chatProvider, embeddingsProvider: fakeEmbeddings() }
      )
    );

    // A concrete, positive limit was passed to the query -- not unbounded.
    expect(historyLimitCalls).toHaveLength(1);
    expect(historyLimitCalls[0]).toBeGreaterThan(0);
    expect(Number.isFinite(historyLimitCalls[0])).toBe(true);

    // Ordering is still correct (oldest-first) despite the underlying query
    // being most-recent-first + reversed back -- see the fake's own
    // `.limit()` implementation for how it simulates that.
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
    // A relevant match -- NOT `[]` -- so the anti-hallucination short-circuit
    // never triggers here; this test is specifically about the chat
    // provider actually being called and then failing.
    const { supabase, inserted } = makeFakeSupabase({ createdConversationId: "conv-new", matches: [matchedChunk()] });
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

  // A completion that streams zero deltas completes `stream.textStream`
  // normally (no throw during iteration -- see lib/ai/stream-utils.ts's
  // "empty-but-successful stream" branch), but `stream.usage` can still
  // reject afterward (e.g. a real AI_NoOutputGeneratedError). This proves
  // that failure is caught too: no exception escapes handleChatRequest, a
  // single graceful `type: "error"` event is yielded instead, and (same as
  // the mid-stream failure case above) no assistant message/usage_events
  // row is persisted for the failed turn.
  it("yields a graceful error event (not an uncaught exception) when the stream completes with ZERO deltas but its usage promise rejects afterward (e.g. a real AI_NoOutputGeneratedError)", async () => {
    // A relevant match -- NOT `[]` -- so this exercises the actual chat
    // provider (and its bug) rather than incidentally short-circuiting via
    // the anti-hallucination guard before ever reaching it.
    const { supabase, inserted } = makeFakeSupabase({ createdConversationId: "conv-new", matches: [matchedChunk()] });
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

  // Regression test for Bug 1 -- distinct from the "zero deltas but usage
  // REJECTS" case above: here the stream resolves completely successfully
  // (the delta loop finishes with no throw, `stream.usage`/`stream.text`
  // both resolve normally) but produced literally zero characters of
  // output text. Before the fix, this fell all the way through to the
  // ordinary success path and persisted a blank ("") assistant message
  // with no error anywhere -- on Telegram specifically,
  // splitTelegramMessage("") returns [] (lib/channels/telegram/client.ts),
  // so the participant would receive NOTHING back, silently.
  it("yields a graceful error event (not a blank persisted message) when the stream resolves successfully but streams ZERO deltas", async () => {
    const { supabase, inserted } = makeFakeSupabase({ createdConversationId: "conv-new", matches: [matchedChunk()] });
    const zeroButSuccessfulChatProvider: ChatProvider = {
      providerName: "fake-chat",
      modelName: "fake-chat-model",
      streamChat: vi.fn().mockImplementation((): ChatStreamResult => ({
        textStream: (async function* () {})(), // yields nothing, completes normally
        usage: Promise.resolve({ promptTokens: 5, completionTokens: 0, totalTokens: 5 }),
        text: Promise.resolve(""),
      })),
    };

    const events = await collect(
      handleChatRequest(baseInput, {
        supabase,
        chatProvider: zeroButSuccessfulChatProvider,
        embeddingsProvider: fakeEmbeddings(),
      })
    );

    // Exactly one graceful error event, nothing else after it -- no `done`.
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(events[events.length - 1]).toBe(errorEvent);
    expect(events.find((e) => e.type === "done")).toBeUndefined();

    // No blank assistant message, no chat_request usage_events row --
    // same "no partial persistence on a failed turn" contract as every
    // other failure path.
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

  // Regression coverage for the live-reproduced hallucination bug (qa-reviewer:
  // one phrasing of a question against a project with zero relevant
  // documents got a confidently fabricated answer, while a reworded
  // resubmission correctly said "У меня нет информации об этом.") -- see
  // MIN_RELEVANT_SIMILARITY's own comment in handle-chat-request.ts for the
  // full reasoning behind enforcing this in code rather than relying purely
  // on the system prompt.
  describe("anti-hallucination short-circuit (no relevant context)", () => {
    it("yields the canned 'no information' reply directly and never calls the chat provider when retrieval returns ZERO chunks", async () => {
      const { supabase, inserted, rpcCalls } = makeFakeSupabase({ createdConversationId: "conv-new", matches: [] });
      const chatProvider = fakeChatProvider(["should never be reached"]);

      const events = await collect(
        handleChatRequest(baseInput, { supabase, chatProvider, embeddingsProvider: fakeEmbeddings() })
      );

      expect(chatProvider.streamChat).not.toHaveBeenCalled();
      expect(events).toEqual([
        { type: "conversation", conversationId: "conv-new" },
        { type: "sources", sources: [] },
        { type: "delta", text: "У меня нет информации об этом." },
        { type: "done", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
      ]);

      const assistantRow = inserted.find((i) => i.table === "messages" && i.row.role === "assistant");
      expect(assistantRow?.row.content).toBe("У меня нет информации об этом.");
      expect(assistantRow?.row.sources).toEqual([]);

      // A chat_request usage_events row IS still written here, with all
      // token counts zero (no real chat-completion call ever happened) --
      // the row itself must exist so checkChatRateLimit's persistent,
      // DB-backed per-project rate limit (a COUNT(*) over chat_request
      // rows) actually sees this turn; see the dedicated rate-limit test
      // below for the end-to-end version of this.
      const chatUsageRow = inserted.find((i) => i.table === "usage_events" && i.row.event_type === "chat_request");
      expect(chatUsageRow).toMatchObject({
        row: { project_id: "project-1", user_id: "owner-1", prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
      // The embedding_request row IS still logged -- a real embeddings call
      // did happen, to search in the first place.
      expect(inserted.find((i) => i.table === "usage_events" && i.row.event_type === "embedding_request")).toBeTruthy();
      // Retrieval genuinely ran the RPC -- it's what determined there was
      // nothing relevant, not a heuristic that skipped calling it.
      expect(rpcCalls).toHaveLength(1);
    });

    // Regression test for Bug 2: before the fix, this short-circuit path
    // never wrote a chat_request usage_events row at all, so
    // checkChatRateLimit's persistent DB-backed limit (a COUNT(*) over
    // chat_request rows in a trailing window) could never see repeated
    // no-context turns against the same project -- only the transient
    // in-memory reservation layer (reserveChatRateLimitSlot) would ever
    // catch them, and that layer alone is bypassable across separate
    // requests once each one's reservation is released. This test uses a
    // purpose-built fake (not makeFakeSupabase, which doesn't model a
    // count-style SELECT) that actually accumulates inserted chat_request
    // rows and answers checkChatRateLimit's real query shape against them.
    it("repeated no-context turns against the same project eventually trip checkChatRateLimit", async () => {
      const chatRequestRows: { created_at: string }[] = [];
      let conversationCounter = 0;

      const countableSupabase = {
        from(table: string) {
          if (table === "conversations") {
            return {
              select() {
                return this;
              },
              eq() {
                return this;
              },
              insert: () => ({
                select() {
                  return this;
                },
                single: async () => ({ data: { id: `conv-${conversationCounter++}` }, error: null }),
              }),
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
              order() {
                return this;
              },
              limit: async () => ({ data: [], error: null }),
              insert: async () => ({ error: null }),
            };
          }
          if (table === "usage_events") {
            return {
              insert: async (row: Record<string, unknown>) => {
                if (row.event_type === "chat_request") {
                  chatRequestRows.push({ created_at: new Date().toISOString() });
                }
                return { error: null };
              },
              // Mirrors checkChatRateLimit's exact query chain
              // (lib/rate-limit/rate-limiter.ts):
              // .select("created_at", {count:"exact"}).eq(...).eq(...).gte(...).order(...)
              select() {
                return this;
              },
              eq() {
                return this;
              },
              gte() {
                return this;
              },
              order: async () => ({ data: chatRequestRows, error: null, count: chatRequestRows.length }),
            };
          }
          throw new Error(`countableSupabase: unexpected table ${table}`);
        },
        rpc: vi.fn().mockResolvedValue({ data: [], error: null }), // no relevant chunks -- always short-circuits
      } as unknown as SupabaseClient;

      const chatProvider = fakeChatProvider(["should never be reached"]);
      const embeddingsProvider = fakeEmbeddings();

      // Send exactly maxRequests no-context turns -- each one, if it
      // actually wrote its own chat_request row, brings the project right
      // up to (but not yet over) the limit.
      for (let i = 0; i < DEFAULT_CHAT_RATE_LIMIT.maxRequests; i++) {
        const events = await collect(
          handleChatRequest(baseInput, { supabase: countableSupabase, chatProvider, embeddingsProvider })
        );
        expect(events.find((e) => e.type === "error")).toBeUndefined();
      }
      expect(chatRequestRows).toHaveLength(DEFAULT_CHAT_RATE_LIMIT.maxRequests);

      const result = await checkChatRateLimit(countableSupabase, "project-1", DEFAULT_CHAT_RATE_LIMIT);
      expect(result.allowed).toBe(false);
      expect(result.currentCount).toBe(DEFAULT_CHAT_RATE_LIMIT.maxRequests);
    });

    it("also short-circuits when retrieval returns chunks but ALL of them fall below the relevance threshold", async () => {
      const { supabase, inserted } = makeFakeSupabase({
        createdConversationId: "conv-new",
        matches: [matchedChunk({ similarity: 0.05 }), matchedChunk({ chunk_id: "chunk-2", similarity: 0.02 })],
      });
      const chatProvider = fakeChatProvider(["should never be reached"]);

      const events = await collect(
        handleChatRequest(baseInput, { supabase, chatProvider, embeddingsProvider: fakeEmbeddings() })
      );

      expect(chatProvider.streamChat).not.toHaveBeenCalled();
      expect(events.find((e) => e.type === "sources")).toEqual({ type: "sources", sources: [] });
      expect(events.find((e) => e.type === "delta")).toEqual({ type: "delta", text: "У меня нет информации об этом." });
      const assistantRow = inserted.find((i) => i.table === "messages" && i.row.role === "assistant");
      expect(assistantRow?.row.content).toBe("У меня нет информации об этом.");
    });

    it("does NOT short-circuit when the top match clears the relevance threshold, even if a lower-ranked one doesn't", async () => {
      const { supabase } = makeFakeSupabase({
        createdConversationId: "conv-new",
        // Sorted most-similar-first, exactly as the real RPC returns them --
        // only the TOP entry needs to clear the bar.
        matches: [matchedChunk({ similarity: 0.5 }), matchedChunk({ chunk_id: "chunk-2", similarity: 0.01 })],
      });
      const chatProvider = fakeChatProvider(["a real grounded answer"]);

      const events = await collect(
        handleChatRequest(baseInput, { supabase, chatProvider, embeddingsProvider: fakeEmbeddings() })
      );

      expect(chatProvider.streamChat).toHaveBeenCalled();
      expect(events.find((e) => e.type === "delta")).toEqual({ type: "delta", text: "a real grounded answer" });
      // Both retrieved chunks are still attached as sources -- this guard
      // only decides WHETHER to call the LLM at all, it doesn't filter
      // individual below-threshold chunks out of an otherwise-relevant
      // context.
      expect(events.find((e) => e.type === "sources")).toMatchObject({
        type: "sources",
        sources: [expect.objectContaining({ chunkId: "chunk-1" }), expect.objectContaining({ chunkId: "chunk-2" })],
      });
    });

    it("treats a similarity exactly AT the threshold as relevant (inclusive boundary)", async () => {
      const { supabase } = makeFakeSupabase({
        createdConversationId: "conv-new",
        matches: [matchedChunk({ similarity: 0.15 })],
      });
      const chatProvider = fakeChatProvider(["boundary answer"]);

      const events = await collect(
        handleChatRequest(baseInput, { supabase, chatProvider, embeddingsProvider: fakeEmbeddings() })
      );

      expect(chatProvider.streamChat).toHaveBeenCalled();
      expect(events.find((e) => e.type === "delta")).toEqual({ type: "delta", text: "boundary answer" });
    });
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
        // A relevant match -- NOT `[]` -- so the anti-hallucination
        // short-circuit doesn't fire before the conversation-creation
        // behavior this test is actually about ever gets exercised.
        matches: [matchedChunk()],
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
        matches: [matchedChunk()],
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
        matches: [matchedChunk()],
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
        // A relevant match -- NOT `[]` -- this test specifically asserts a
        // `chat_request` usage_events row exists, which the
        // anti-hallucination short-circuit deliberately never inserts (no
        // chat-completion call happens on that path).
        matches: [matchedChunk()],
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
        matches: [matchedChunk()],
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
