// lib/ai/types.ts
//
// The whole point of this file: retrieval, API routes and any other
// business logic in this project depend on THESE interfaces only. They
// never import `openai`/`@anthropic-ai/*`/`voyageai`/`@ai-sdk/*` directly --
// only code inside lib/ai/providers/ (and lib/ai/index.ts, which wires
// providers together) is allowed to reach for a vendor SDK. See CLAUDE.md
// rule 4 and lib/ai/index.ts's factory comment.

/** A single turn of chat history, in the shape every ChatProvider accepts. */
export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/**
 * Token accounting for a single chat/embedding call, already normalized
 * across providers (OpenAI/Anthropic/Voyage/Gemini all report usage under
 * different field names -- see lib/ai/stream-utils.ts and provider
 * adapters for where that mapping happens). Fields are 0 rather than
 * undefined when a provider genuinely doesn't report a given number, so
 * callers (usage_events logging) never have to null-check.
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Result of starting a streamed chat completion. `textStream` yields
 * incremental text deltas in order; `usage`/`text` resolve once the stream
 * has been fully consumed (reading them before draining `textStream` will
 * hang until the stream finishes, same contract as the Vercel AI SDK's own
 * `streamText` result, which every ChatProvider adapter wraps).
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
 * Embeddings, provider-agnostic. Every implementation is configured to
 * output `dimensions`-sized vectors (fixed at 1024 project-wide, see
 * lib/ai/providers/*) so document_chunks.embedding (vector(1024)) works
 * unchanged no matter which AI_PROVIDER is active. 1024 was chosen because
 * it's Voyage's own default `output_dimension` and the largest value in
 * Voyage's supported set ({256, 512, 1024, 2048}) that OpenAI/Gemini can
 * also shorten down to arbitrarily -- Voyage does NOT support 1536 at all
 * (see CLAUDE.md). Switching providers
 * still requires a full re-embed -- different models produce incompatible
 * vector spaces even at equal dimensionality (see CLAUDE.md).
 */
export interface EmbeddingsProvider {
  readonly providerName: string;
  readonly modelName: string;
  readonly dimensions: number;
  /**
   * Embeds `texts` in input order and returns one vector per input, at the
   * same index. Batches internally; on a batch-level failure it bisects to
   * isolate the offending input(s) rather than failing every chunk in a
   * large batch for one bad item (see lib/ai/embed-batch.ts). Either
   * resolves with `texts.length` vectors, or rejects with an
   * AIProviderError -- never returns a partial/misaligned array, since
   * callers (lib/ingestion/ingest.ts) rely on index i of the result
   * lining up with chunk_index i.
   */
  embed(texts: string[]): Promise<number[][]>;
}

/** What lib/ai/index.ts hands back to the rest of the app for the active AI_PROVIDER. */
export interface AIProviderPair {
  chatProvider: ChatProvider;
  embeddingsProvider: EmbeddingsProvider;
}
