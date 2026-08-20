// lib/ai/providers/openai.ts
//
// Chat + embeddings adapter for any OpenAI-Chat-Completions-API-compatible
// backend. This file is one of the few places in the codebase allowed to
// import the `openai` / `@ai-sdk/openai` SDKs directly (see CLAUDE.md rule
// 4 and lib/ai/index.ts).
//
// providers/gemini.ts constructs this exact class again, pointed at
// Google's OpenAI-compatible endpoint via `baseURL` -- see the comment
// there for why that's a deliberate reuse (Google officially supports the
// OpenAI Chat Completions + Embeddings wire format), not a copy-paste
// mistake.

import OpenAI from "openai";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";
import type {
  ChatMessage,
  ChatProvider,
  ChatStreamResult,
  EmbeddingsProvider,
} from "../types";
import { embedInBatches } from "../embed-batch";
import { wrapAiSdkStream } from "../stream-utils";

/** Fixed project-wide so pgvector's `vector(1024)` column works unchanged across providers -- see CLAUDE.md and document_chunks migration. 1024 (not 1536) because Voyage AI -- used for AI_PROVIDER=anthropic embeddings -- only supports output_dimension in {256, 512, 1024, 2048}; 1024 is Voyage's own default and the common denominator across all three providers. */
export const OPENAI_EMBEDDING_DIMENSIONS = 1024;

/** OpenAI accepts up to 2048 inputs per embeddings call; we batch well under that so a single bad chunk (see embed-batch.ts bisection) doesn't force retrying a huge batch. */
const EMBEDDING_BATCH_SIZE = 100;

export interface OpenAICompatibleConfig {
  /** Machine-readable provider id used in usage_events.provider / error messages. Defaults to 'openai'; providers/gemini.ts passes 'gemini' when reusing this class. */
  providerName?: string;
  apiKey: string;
  /** Overrides the OpenAI API base URL -- this is the hook providers/gemini.ts uses to point this same class at Google's OpenAI-compatible endpoint instead of api.openai.com. */
  baseURL?: string;
  chatModel: string;
  embeddingModel: string;
}

/**
 * Internal implementation shared by the chat-role and embeddings-role views
 * returned by createOpenAICompatiblePair() below. Deliberately NOT exported
 * and deliberately does NOT `implements ChatProvider, EmbeddingsProvider`
 * itself.
 *
 * Why: ChatProvider.modelName and EmbeddingsProvider.modelName are two
 * *semantically different* fields (chat model vs. embedding model) that
 * happen to share the same `string` type -- TypeScript's structural typing
 * has no way to say "this field means X when read through interface A and Y
 * when read through interface B" on ONE object. A previous version of this
 * file had this class implement both interfaces directly with a single
 * `modelName` field (= chatModel), and lib/ai/index.ts handed the exact
 * same object out as both `chatProvider` and `embeddingsProvider`. That
 * compiled fine (both interfaces are satisfied by a `string` field) but was
 * wrong at runtime: `embeddingsProvider.modelName` returned the CHAT model,
 * which lib/ingestion/ingest.ts writes into
 * document_chunks.embedding_model -- silently mislabeling every ingested
 * row's embedding model as e.g. "gemini-3.6-flash" instead of
 * "gemini-embedding-001" (reproduced live against a real Google Drive
 * document under AI_PROVIDER=gemini). The actual embed() API call always
 * used the correct `embeddingModelName` -- vectors were never wrong, only
 * the metadata describing them. Fixed by never handing out a dual-interface
 * object: createOpenAICompatiblePair() is the only supported way to get a
 * provider pair out of this file, and it returns two distinct thin views
 * (see below), each with its own correct `modelName`, both delegating to
 * one shared instance of this class so there's still exactly one HTTP
 * client / API key / baseURL per process.
 */
class OpenAICompatibleCore {
  readonly providerName: string;
  readonly chatModelName: string;
  readonly embeddingModelName: string;
  readonly dimensions = OPENAI_EMBEDDING_DIMENSIONS;
  private readonly rawClient: OpenAI;
  private readonly aiSdk: ReturnType<typeof createOpenAI>;

  constructor(config: OpenAICompatibleConfig) {
    this.providerName = config.providerName ?? "openai";
    this.chatModelName = config.chatModel;
    this.embeddingModelName = config.embeddingModel;
    // maxRetries: 0 -- lib/ai/retry.ts and lib/ai/stream-utils.ts are the
    // single retry layer for this project (consistent backoff, consistent
    // AIProviderError shape); the vendor SDK's own built-in retry would
    // otherwise silently retry underneath ours with different timing.
    this.rawClient = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      maxRetries: 0,
    });
    this.aiSdk = createOpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  }

  streamChat({
    systemPrompt,
    messages,
  }: {
    systemPrompt: string;
    messages: ChatMessage[];
  }): ChatStreamResult {
    // `.chat(...)` explicitly selects the Chat Completions API rather than
    // OpenAI's newer Responses API -- required for Gemini's compatible
    // endpoint, which only implements Chat Completions, and kept the same
    // for the real OpenAI adapter so both code paths behave identically.
    const model = this.aiSdk.chat(this.chatModelName);
    return wrapAiSdkStream(
      () =>
        streamText({
          model,
          system: systemPrompt,
          messages,
          maxRetries: 0, // see the constructor comment: our own retry wrapper is the only retry layer
        }),
      { provider: this.providerName }
    );
  }

  async embed(texts: string[]): Promise<number[][]> {
    return embedInBatches(texts, {
      provider: this.providerName,
      batchSize: EMBEDDING_BATCH_SIZE,
      callBatch: async (batch) => {
        // `dimensions` is what pins every provider to the same 1024-wide
        // vector space (see CLAUDE.md). For the real OpenAI API this is the
        // native `dimensions` request field (text-embedding-3-small
        // supports shortening its output via this param). When this class
        // is reused by providers/gemini.ts against Google's OpenAI-
        // compatible endpoint, Google maps this same `dimensions` field to
        // Gemini's native `output_dimensionality` parameter -- one code
        // path, two providers, per the compatibility guarantee documented
        // in providers/gemini.ts.
        const response = await this.rawClient.embeddings.create({
          model: this.embeddingModelName,
          input: batch,
          dimensions: this.dimensions,
        });
        // Defensively sort by `.index`: OpenAI documents the response as
        // matching input order, but nothing stops a third-party
        // OpenAI-compatible backend (Gemini) from reordering, and we'd
        // rather pay a `.sort()` than silently misalign chunk<->vector.
        return response.data
          .slice()
          .sort((a, b) => a.index - b.index)
          .map((item) => item.embedding);
      },
    });
  }
}

/**
 * The only supported way to get a {chatProvider, embeddingsProvider} pair
 * backed by an OpenAI-Chat-Completions-API-compatible endpoint (real OpenAI,
 * or -- via providers/gemini.ts -- Google's OpenAI-compatible endpoint).
 * Constructs exactly ONE OpenAICompatibleCore (one HTTP client, one API
 * key/baseURL pair) and returns two independent, correctly-labeled views
 * over it -- see the OpenAICompatibleCore class comment for why this is two
 * objects instead of one dual-interface object.
 */
export function createOpenAICompatiblePair(
  config: OpenAICompatibleConfig
): { chatProvider: ChatProvider; embeddingsProvider: EmbeddingsProvider } {
  const core = new OpenAICompatibleCore(config);

  const chatProvider: ChatProvider = {
    providerName: core.providerName,
    modelName: core.chatModelName,
    streamChat: (input) => core.streamChat(input),
  };

  const embeddingsProvider: EmbeddingsProvider = {
    providerName: core.providerName,
    modelName: core.embeddingModelName,
    dimensions: core.dimensions,
    embed: (texts) => core.embed(texts),
  };

  return { chatProvider, embeddingsProvider };
}
