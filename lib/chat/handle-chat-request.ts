// lib/chat/handle-chat-request.ts
//
// The framework-agnostic core of the chat pipeline: resolve/create a
// conversation, persist the user's message, run retrieval, stream the
// answer from the active ChatProvider, persist the assistant's message +
// sources + usage_events. Deliberately has no knowledge of Next.js/HTTP --
// app/api/chat/route.ts is a thin adapter that does auth + rate limiting
// (proper 401/429 status codes) and turns this generator into an SSE
// Response; lib/gateway/answer.ts is a second, non-streaming caller for
// external channel messages (Telegram etc, see that module). Keeping this
// split is what makes the pipeline unit-testable with fakes (see
// __tests__/handle-chat-request.test.ts) instead of needing a running
// Next.js server, and is what lets ONE persistence code path serve both the
// owner's own test chat and every external channel session of a project
// (projects architecture pivot) without forking by caller type.
//
// SECURITY: `projectId`/`ownerUserId` must come from an already
// independently-verified source -- see app/api/chat/route.ts (RLS-scoped
// ownership check before ever calling this) / lib/gateway/answer.ts (the
// gateway's own service-role project-owner lookup, keyed off the
// channel_integrations row that received the inbound webhook, never off
// anything in the inbound payload itself). Never pass a client-supplied
// projectId/ownerUserId here.
//
// Two ownership shapes share this one pipeline (see the conversations
// migration's table comment): the project OWNER's own in-app test chat
// (`input.externalParticipant` omitted -- conversations.user_id =
// ownerUserId, channel/external_participant_id null) and an EXTERNAL
// channel participant's session (`input.externalParticipant` set --
// conversations.user_id = null, channel/external_participant_id set, found
// via upsert against the (project_id, channel, external_participant_id)
// partial unique index rather than a client-supplied conversationId, since
// an inbound Telegram update carries none). `usage_events.user_id` is
// always `input.ownerUserId` for BOTH shapes -- external participants have
// no auth.users row of their own to attribute cost to; it's the project
// owner's credentials/budget being spent either way.
//
// Rate limiting is intentionally NOT checked in here -- see
// app/api/chat/route.ts (layer 1 only, web path) / lib/gateway/answer.ts
// (all three concurrency layers, external-channel path), which check it
// before starting this generator so a rejected request gets a plain 429 (or
// GatewayAnswerResult{kind:"rate_limited"}) instead of a partially-started
// stream.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChatMessage, ChatProvider, EmbeddingsProvider, TokenUsage } from "../ai/types";
import { AIProviderError, normalizeProviderError } from "../ai/errors";
import { runRetrieval, type ContextSource } from "../retrieval/search";
import { RAG_SYSTEM_PROMPT } from "../retrieval/system-prompt";
import { estimateTokens } from "../tokens";

/** Identifies an external channel participant (e.g. a Telegram chat_id) -- see the module header's "two ownership shapes" comment. Opaque strings: this module doesn't interpret `channel` beyond using it as part of the conversations find-or-create key. */
export interface ExternalParticipant {
  channel: string;
  participantId: string;
}

export interface ChatRequestInput {
  /** The project this chat turn is scoped to -- documents/retrieval/rate-limiting/usage_events all key off this. */
  projectId: string;
  /** The project's owner -- always the account whose credentials/budget this turn spends, and the `conversations.user_id`/`usage_events.user_id` value for the OWNER (non-external) path. See the module header. */
  ownerUserId: string;
  /** Existing conversation to continue, or omitted to start a new one. Owner path only -- ignored (never consulted) when `externalParticipant` is set, since an inbound channel message carries no conversationId of its own; see resolveConversationId(). */
  conversationId?: string;
  /** Set for an external-channel-shaped turn (e.g. a Telegram message) -- see the module header's "two ownership shapes" comment. Omit for the project owner's own test chat. */
  externalParticipant?: ExternalParticipant;
  message: string;
}

export interface ChatRequestDeps {
  /** Service-role client -- see lib/supabase/service-client.ts. All reads/writes here are already scoped by the validated projectId/ownerUserId above, not by RLS. */
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

/**
 * Find-or-create for an external channel session, keyed by
 * (project_id, channel, external_participant_id) -- the partial unique
 * index `conversations_external_participant_unique` (`where channel is not
 * null`, see the conversations migration).
 *
 * NOT implemented as `supabase.from("conversations").upsert(..., {
 * onConflict: "..." })`, even though that's the idiomatic
 * supabase-js shape for find-or-create elsewhere in this codebase (e.g.
 * lib/ai/credentials.ts's saveAIProviderCredential) -- deliberately, after
 * hitting this live against real Postgres: PostgREST's `on_conflict` query
 * param only ever emits a plain `ON CONFLICT (col1, col2, ...)` column-list
 * target, with no way to also pass the index's `WHERE channel IS NOT NULL`
 * predicate. Postgres requires an ON CONFLICT target to match a unique
 * index/constraint EXACTLY, including any partial predicate, to infer it --
 * a bare column-list target cannot match a partial unique index at all, and
 * the query fails with "there is no unique or exclusion constraint
 * matching the ON CONFLICT specification" (reproduced live, not a
 * theoretical concern). A non-partial unique index would work with
 * `upsert()`, but the partial index is deliberate on db-architect's side
 * (see the conversations migration: the owner's own test-chat rows have no
 * such natural dedup key and can legitimately have many
 * channel/external_participant_id-both-null rows).
 *
 * Instead: SELECT first (this is the fast path on every message after the
 * first -- a repeat Telegram sender's conversation already exists), and
 * only INSERT on a miss. A concurrent double-insert race (two overlapping
 * webhook deliveries for a brand-new participant, both missing the SELECT)
 * is closed by catching Postgres's unique-violation error code (23505) on
 * the INSERT and re-SELECTing -- the losing request ends up with the
 * winner's row, not a duplicate. This is a real, not just theoretical,
 * race window this module's caller (lib/gateway/answer.ts) additionally
 * narrows with its own per-conversation lock (layer 3) -- see that
 * module's header -- but the DB-level catch here is what makes this
 * function correct even without that lock (e.g. if the lock is ever
 * bypassed or this function is reused by a future caller that doesn't
 * have one).
 */
async function resolveExternalConversation(
  supabase: SupabaseClient,
  projectId: string,
  externalParticipant: ExternalParticipant
): Promise<{ id: string; isNew: boolean } | { error: string }> {
  const { channel, participantId } = externalParticipant;
  const matchFilter = { project_id: projectId, channel, external_participant_id: participantId };

  const { data: existing, error: selectError } = await supabase
    .from("conversations")
    .select("id")
    .match(matchFilter)
    .maybeSingle();
  if (selectError) {
    return { error: `Не удалось найти диалог: ${selectError.message}` };
  }
  if (existing) {
    return { id: existing.id as string, isNew: false };
  }

  const { data: inserted, error: insertError } = await supabase
    .from("conversations")
    .insert(matchFilter)
    .select("id")
    .single();
  if (!insertError && inserted) {
    return { id: inserted.id as string, isNew: true };
  }

  // 23505 = unique_violation: lost a race against a concurrent insert for
  // the same (project_id, channel, external_participant_id) -- the winner
  // already created the row we were trying to create; find and use it
  // rather than surfacing an error for what is, from the caller's
  // perspective, a completely normal outcome.
  if (insertError?.code === "23505") {
    const { data: raceWinner, error: raceSelectError } = await supabase
      .from("conversations")
      .select("id")
      .match(matchFilter)
      .maybeSingle();
    if (raceSelectError) {
      return { error: `Не удалось найти диалог: ${raceSelectError.message}` };
    }
    if (raceWinner) {
      return { id: raceWinner.id as string, isNew: false };
    }
  }

  return { error: `Не удалось найти или создать диалог: ${insertError?.message ?? "unknown error"}` };
}

async function resolveConversationId(
  supabase: SupabaseClient,
  input: Pick<ChatRequestInput, "projectId" | "ownerUserId" | "conversationId" | "externalParticipant">,
  firstMessage: string
): Promise<{ id: string; isNew: boolean } | { error: string }> {
  if (input.externalParticipant) {
    return resolveExternalConversation(supabase, input.projectId, input.externalParticipant);
  }

  if (input.conversationId) {
    const { data, error } = await supabase
      .from("conversations")
      .select("id")
      .eq("id", input.conversationId)
      .eq("project_id", input.projectId)
      .eq("user_id", input.ownerUserId)
      .maybeSingle();
    if (error) return { error: `Не удалось найти диалог: ${error.message}` };
    if (!data) return { error: "Диалог не найден." };
    return { id: input.conversationId, isNew: false };
  }

  const { data, error } = await supabase
    .from("conversations")
    .insert({ project_id: input.projectId, user_id: input.ownerUserId, title: deriveConversationTitle(firstMessage) })
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
 * chat provider failure after retries, OR a completion that streams zero
 * deltas and then rejects `usage`/`text` afterward -- e.g. a real
 * AI_NoOutputGeneratedError, see the try/catch around the streaming block
 * below) are yielded as `{ type: 'error' }` events rather than thrown, so
 * the caller (the API route, or lib/gateway/answer.ts) can forward them
 * appropriately instead of needing a separate error channel. Unexpected
 * failures (e.g. a DB write erroring) are allowed to throw -- the caller's
 * own try/catch around iterating this generator is the backstop for those
 * (lib/gateway/answer.ts's drain loop has one specifically as
 * defense-in-depth against this contract ever being violated again).
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
    { projectId: input.projectId, ownerUserId: input.ownerUserId, conversationId: input.conversationId, externalParticipant: input.externalParticipant },
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
  // chat-completion failure's and deserve the same graceful `error`
  // event instead of falling through to the caller's generic catch-all
  // (which always hardcodes retryable: false regardless of whether the
  // underlying failure -- e.g. a 429 from the embeddings provider -- was
  // actually retryable).
  //
  // A non-AIProviderError here (e.g. the plain Error that
  // lib/retrieval/search.ts throws when the match_document_chunks RPC call
  // itself fails) is a genuinely unexpected failure, not a
  // classified/retryable AI-provider condition -- left to propagate and be
  // caught by the caller's own catch-all, per this module's "Error
  // handling" doc comment above.
  let retrieval;
  try {
    retrieval = await runRetrieval(
      trimmedMessage,
      input.projectId,
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
  // not a billing-accurate figure. user_id stays the project OWNER for
  // both ownership shapes -- see the module header.
  const { error: embeddingUsageError } = await deps.supabase.from("usage_events").insert({
    project_id: input.projectId,
    user_id: input.ownerUserId,
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

  // NOTE (bug found live, see git history): `stream.usage` used to be
  // awaited OUTSIDE this try, after the delta loop. That's an easy trap --
  // a completion that streams zero deltas (e.g. wrapAiSdkStream's
  // "empty-but-successful stream" branch, lib/ai/stream-utils.ts) exits the
  // `for await` loop normally, without throwing, so nothing in the old
  // try/catch ever fired; the underlying AI SDK's `usage`/`text` promises
  // can *still* reject on their own afterward (reproduced live: a real
  // AI_NoOutputGeneratedError from Gemini after wrapAiSdkStream's retry
  // budget was exhausted against a 429) -- and that rejection, awaited with
  // no try/catch around it, escaped this generator as a raw, unnormalized
  // exception instead of a graceful `error` event. `stream.usage` is now
  // awaited INSIDE the same try, so a failure at that point gets the exact
  // same normalize-and-yield treatment as a failure during streaming
  // itself (same catch body, deliberately -- normalizeProviderError() is
  // idempotent on an already-normalized AIProviderError, and unconditional
  // normalization here, not gated on `instanceof AIProviderError` the way
  // the retrieval catch above is, matches this block's pre-existing
  // delta-loop catch, which never gated on that either).
  let fullText = "";
  let usage: TokenUsage;
  try {
    for await (const delta of stream.textStream) {
      fullText += delta;
      yield { type: "delta", text: delta };
    }
    usage = await stream.usage;
  } catch (rawErr) {
    const err = normalizeProviderError(rawErr, deps.chatProvider.providerName);
    yield { type: "error", message: err.userMessage, retryable: err.retryable };
    return; // no assistant message / usage_events row on failure -- see module comment
  }

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
    project_id: input.projectId,
    user_id: input.ownerUserId,
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
