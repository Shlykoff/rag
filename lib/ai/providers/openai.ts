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

export class OpenAICompatibleProvider
  implements ChatProvider, EmbeddingsProvider
{
  readonly providerName: string;
  readonly modelName: string;
  readonly dimensions = OPENAI_EMBEDDING_DIMENSIONS;
  private readonly embeddingModelName: string;
  private readonly rawClient: OpenAI;
  private readonly aiSdk: ReturnType<typeof createOpenAI>;

  constructor(config: OpenAICompatibleConfig) {
    this.providerName = config.providerName ?? "openai";
    this.modelName = config.chatModel;
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
    const model = this.aiSdk.chat(this.modelName);
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
