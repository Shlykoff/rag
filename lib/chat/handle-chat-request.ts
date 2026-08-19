// lib/chat/handle-chat-request.ts
//
// The framework-agnostic core of the chat pipeline: resolve/create a
// conversation, persist the user's message, run retrieval, stream the
// answer from the active ChatProvider, persist the assistant's message +
// sources + usage_events. Deliberately has no knowledge of Next.js/HTTP --
// app/api/chat/route.ts is a thin adapter that does auth + rate limiting
// (proper 401/429 status codes) and turns this generator into an SSE
// Response. Keeping this split is what makes the pipeline unit-testable
// with fakes (see __tests__/handle-chat-request.test.ts) instead of
// needing a running Next.js server.
//
// SECURITY: `userId` must come from a validated server-side session (see
// app/api/chat/route.ts / lib/supabase/server-client.ts) -- it is used
// both as the match_document_chunks p_user_id (via lib/retrieval/search.ts)
// and to scope/authorize conversation access. Never pass a client-supplied
// userId here.
//
// Rate limiting is intentionally NOT checked in here -- see
// app/api/chat/route.ts, which checks it before starting this generator so
// a rejected request gets a plain 429 response instead of a partially
//-started SSE stream.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChatMessage, ChatProvider, EmbeddingsProvider, TokenUsage } from "../ai/types";
import { AIProviderError, normalizeProviderError } from "../ai/errors";
import { runRetrieval, type ContextSource } from "../retrieval/search";
import { RAG_SYSTEM_PROMPT } from "../retrieval/system-prompt";
import { estimateTokens } from "../tokens";

export interface ChatRequestInput {
  userId: string;
  /** Existing conversation to continue, or omitted to start a new one. */
  conversationId?: string;
  message: string;
}

export interface ChatRequestDeps {
  /** Service-role client -- see lib/supabase/service-client.ts. All reads/writes here are already scoped by the validated userId above, not by RLS. */
  supabase: SupabaseClient;
  chatProvider: ChatProvider;
  embeddingsProvider: EmbeddingsProvider;
  /** top-k / context budget forwarded to runRetrieval; see lib/retrieval/search.ts defaults. */
  retrievalOptions?: Parameters<typeof runRetrieval>[3];
}

export type ChatStreamEvent =
  | { type: "conversation"; conversationId: string }
  | { type: "sources"; sources: ContextSource[] }
  | { type: "delta"; text: string }
  | { type: "done"; usage: TokenUsage }
  | { type: "error"; message: string; retryable: boolean };

const MAX_TITLE_LENGTH = 60;

function deriveConversationTitle(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, " ");
  return trimmed.length <= MAX_TITLE_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MAX_TITLE_LENGTH - 1)}…`;
}

async function resolveConversationId(
  supabase: SupabaseClient,
  userId: string,
  conversationId: string | undefined,
  firstMessage: string
): Promise<{ id: string; isNew: boolean } | { error: string }> {
  if (conversationId) {
    const { data, error } = await supabase
      .from("conversations")
      .select("id")
      .eq("id", conversationId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return { error: `Не удалось найти диалог: ${error.message}` };
    if (!data) return { error: "Диалог не найден." };
    return { id: conversationId, isNew: false };
  }

  const { data, error } = await supabase
    .from("conversations")
    .insert({ user_id: userId, title: deriveConversationTitle(firstMessage) })
    .select("id")
    .single();
  if (error || !data) {
    return { error: `Не удалось создать диалог: ${error?.message ?? "unknown error"}` };
  }
  return { id: data.id as string, isNew: true };
}

interface PriorMessageRow {
  role: "user" | "assistant";
  content: string;
}

async function fetchHistory(
  supabase: SupabaseClient,
  conversationId: string
): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  if (error) {
    throw new Error(`fetchHistory: failed to load messages for ${conversationId}: ${error.message}`);
  }
  return ((data ?? []) as PriorMessageRow[]).map((row) => ({ role: row.role, content: row.content }));
}

function buildSystemPromptWithContext(contextText: string): string {
  const contextBlock =
    contextText.length > 0
      ? contextText
      : "(В базе знаний пользователя не найдено релевантных фрагментов для этого вопроса.)";
  return `${RAG_SYSTEM_PROMPT}\n\nКонтекст:\n${contextBlock}`;
}

/**
 * Runs one full chat turn and yields a sequence of events describing its
 * progress -- see ChatStreamEvent. Persists the user message, the
 * assistant message (with sources), and usage_events rows for both the
 * embedding call (retrieval) and the chat completion, as a side effect.
 *
 * Error handling: known, expected failure modes (conversation not found,
 * chat provider failure after retries) are yielded as `{ type: 'error' }`
 * events rather than thrown, so the caller (the API route) can forward
 * them to the client over the same SSE stream instead of needing a
 * separate error channel. Unexpected failures (e.g. a DB write erroring)
 * are allowed to throw -- the route handler's own try/catch around
 * iterating this generator is the backstop for those.
 */
export async function* handleChatRequest(
  input: ChatRequestInput,
  deps: ChatRequestDeps
): AsyncGenerator<ChatStreamEvent> {
  const trimmedMessage = input.message.trim();
  if (trimmedMessage.length === 0) {
    yield { type: "error", message: "Сообщение не может быть пустым.", retryable: false };
    return;
  }

  const conversation = await resolveConversationId(
    deps.supabase,
    input.userId,
    input.conversationId,
    trimmedMessage
  );
  if ("error" in conversation) {
    yield { type: "error", message: conversation.error, retryable: false };
    return;
  }
  yield { type: "conversation", conversationId: conversation.id };

  const history = conversation.isNew
    ? []
    : await fetchHistory(deps.supabase, conversation.id);

  const { error: insertUserMessageError } = await deps.supabase.from("messages").insert({
    conversation_id: conversation.id,
    role: "user",
    content: trimmedMessage,
    sources: [],
  });
  if (insertUserMessageError) {
    throw new Error(`handleChatRequest: failed to persist user message: ${insertUserMessageError.message}`);
  }

  // Same normalize-error-and-yield pattern as the chatProvider.streamChat
  // try/catch below: runRetrieval calls deps.embeddingsProvider.embed(),
  // which (per lib/ai/types.ts's EmbeddingsProvider contract) always
  // rejects with an already-normalized AIProviderError, never a raw vendor
  // error -- so its retryable/userMessage are just as trustworthy as a
  // chat-completion failure's and deserve the same graceful SSE `error`
  // event instead of falling through to the route handler's generic
  // catch-all (which always hardcodes retryable: false regardless of
  // whether the underlying failure -- e.g. a 429 from the embeddings
  // provider -- was actually retryable).
  //
  // A non-AIProviderError here (e.g. the plain Error that
  // lib/retrieval/search.ts throws when the match_document_chunks RPC call
  // itself fails) is a genuinely unexpected failure, not a
  // classified/retryable AI-provider condition -- left to propagate and be
  // caught by the route handler's own catch-all, per this module's
  // "Error handling" doc comment above.
  let retrieval;
  try {
    retrieval = await runRetrieval(
      trimmedMessage,
      input.userId,
      { supabase: deps.supabase, embeddingsProvider: deps.embeddingsProvider },
      deps.retrievalOptions
    );
  } catch (rawErr) {
    if (rawErr instanceof AIProviderError) {
      const err = normalizeProviderError(rawErr, deps.embeddingsProvider.providerName);
      yield { type: "error", message: err.userMessage, retryable: err.retryable };
      return; // no assistant message / usage_events row on failure -- see module comment
    }
    throw rawErr;
  }

  // Best-effort cost visibility for the embedding call: EmbeddingsProvider
  // (lib/ai/types.ts) intentionally returns only vectors, not a usage
  // object (unlike ChatProvider, whose usage is exact/provider-reported --
  // see lib/ai/stream-utils.ts), so this is an *estimate*
  // (lib/tokens.ts's chars/4 heuristic) logged for rough cost tracking,
  // not a billing-accurate figure.
  const { error: embeddingUsageError } = await deps.supabase.from("usage_events").insert({
    user_id: input.userId,
    event_type: "embedding_request",
    provider: deps.embeddingsProvider.providerName,
    model: deps.embeddingsProvider.modelName,
    prompt_tokens: estimateTokens(trimmedMessage),
    completion_tokens: null,
    total_tokens: estimateTokens(trimmedMessage),
  });
  if (embeddingUsageError) {
    // Non-fatal: usage logging must never block the user from getting an
    // answer. Logged server-side for operators to notice, not surfaced to
    // the client.
    console.error(`handleChatRequest: failed to log embedding_request usage: ${embeddingUsageError.message}`);
  }

  yield { type: "sources", sources: retrieval.sources };

  const systemPrompt = buildSystemPromptWithContext(retrieval.contextText);
  const messages: ChatMessage[] = [...history, { role: "user", content: trimmedMessage }];

  const stream = deps.chatProvider.streamChat({ systemPrompt, messages });

  let fullText = "";
  try {
    for await (const delta of stream.textStream) {
      fullText += delta;
      yield { type: "delta", text: delta };
    }
  } catch (rawErr) {
    const err = normalizeProviderError(rawErr, deps.chatProvider.providerName);
    yield { type: "error", message: err.userMessage, retryable: err.retryable };
    return; // no assistant message / usage_events row on failure -- see module comment
  }

  const usage = await stream.usage;

  const { error: insertAssistantMessageError } = await deps.supabase.from("messages").insert({
    conversation_id: conversation.id,
    role: "assistant",
    content: fullText,
    sources: retrieval.sources,
  });
  if (insertAssistantMessageError) {
    throw new Error(
      `handleChatRequest: failed to persist assistant message: ${insertAssistantMessageError.message}`
    );
  }

  const { error: chatUsageError } = await deps.supabase.from("usage_events").insert({
    user_id: input.userId,
    event_type: "chat_request",
    provider: deps.chatProvider.providerName,
    model: deps.chatProvider.modelName,
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
  });
  if (chatUsageError) {
    console.error(`handleChatRequest: failed to log chat_request usage: ${chatUsageError.message}`);
  }

  yield { type: "done", usage };
}
