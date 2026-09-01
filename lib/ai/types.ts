// lib/ai/types.ts
//
// Retrieval, API routes and other business logic depend on these interfaces
// only, never on `openai`/`@anthropic-ai/*`/`voyageai`/`@ai-sdk/*` directly --
// only lib/ai/providers/ and lib/ai/index.ts (which wires providers
// together) may reach for a vendor SDK (CLAUDE.md rule 4).

/** A single turn of chat history, in the shape every ChatProvider accepts. */
export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/**
 * Token accounting for a single chat/embedding call, normalized across
 * providers (each reports usage under different field names -- see
 * lib/ai/stream-utils.ts and provider adapters). Fields are 0 rather than
 * undefined when a provider doesn't report a given number, so callers
 * (usage_events logging) never have to null-check.
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Result of starting a streamed chat completion. `textStream` yields
 * incremental text deltas in order; `usage`/`text` resolve once the stream
 * is fully consumed (reading them before draining `textStream` hangs until
 * the stream finishes -- same contract as the Vercel AI SDK's `streamText`
 * result, which every ChatProvider adapter wraps).
 */
export interface ChatStreamResult {
  textStream: AsyncIterable<string>;
  usage: Promise<TokenUsage>;
  text: Promise<string>;
}

/**
 * Streaming chat completion, provider-agnostic. Implementations own their
 * own retry-before-first-token behavior (see lib/ai/stream-utils.ts) so
 * callers get a uniform AIProviderError (lib/ai/errors.ts) on failure
 * regardless of which vendor is behind it.
 */
export interface ChatProvider {
  /** Machine-readable id used in usage_events.provider / logs, e.g. 'openai' | 'anthropic' | 'gemini'. */
  readonly providerName: string;
  /** Concrete model name, e.g. 'gpt-4.1-mini', used in usage_events.model / logs. */
  readonly modelName: string;
  streamChat(input: {
    systemPrompt: string;
    messages: ChatMessage[];
  }): ChatStreamResult;
}

/**
 * Embeddings, provider-agnostic. Every implementation outputs
 * `dimensions`-sized vectors, fixed at 1024 project-wide (see
 * lib/ai/providers/*), so document_chunks.embedding (vector(1024)) works
 * regardless of the active provider -- 1024 is Voyage's default and within
 * OpenAI/Gemini's shortenable range too (see CLAUDE.md for why). Switching
 * providers still requires a full re-embed: different models produce
 * incompatible vector spaces even at equal dimensionality.
 */
export interface EmbeddingsProvider {
  readonly providerName: string;
  readonly modelName: string;
  readonly dimensions: number;
  /**
   * Embeds `texts` in input order, one vector per input at the same index.
   * Batches internally; on a batch-level failure it bisects to isolate the
   * offending input(s) rather than failing the whole batch (see
   * lib/ai/embed-batch.ts). Resolves with `texts.length` vectors or rejects
   * with an AIProviderError -- never a partial/misaligned array, since
   * callers (lib/ingestion/ingest.ts) rely on result index i matching
   * chunk_index i.
   */
  embed(texts: string[]): Promise<number[][]>;
}

/** What lib/ai/index.ts hands back to the rest of the app for the active AI_PROVIDER. */
export interface AIProviderPair {
  chatProvider: ChatProvider;
  embeddingsProvider: EmbeddingsProvider;
}
