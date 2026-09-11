// lib/ai/providers/openai.ts
//
// Chat and embeddings adapters for any OpenAI-API-compatible backend. One of
// the few places allowed to import the `openai` / `@ai-sdk/openai` SDKs
// directly (CLAUDE.md rule 4).
//
// providers/gemini.ts constructs these same classes, pointed at Google's
// OpenAI-compatible endpoint via `baseURL` -- a deliberate reuse (Google
// officially supports the OpenAI Chat Completions + Embeddings wire format),
// not a copy-paste mistake.

import OpenAI from "openai";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";
import type { ChatMessage, ChatProvider, ChatStreamResult, EmbeddingsProvider } from "../types";
import { embedInBatches } from "../embed-batch";
import { fromStreamTextResult, logStreamError, wrapAiSdkStream } from "../stream-utils";

/** OpenAI accepts up to 2048 inputs per call; smaller batches keep embed-batch.ts's bisection of a failing batch cheap. */
const EMBEDDING_BATCH_SIZE = 100;

export interface OpenAICompatibleClientConfig {
  /** usage_events.provider / error label. Defaults to 'openai'; providers/gemini.ts passes 'gemini'. */
  providerName?: string;
  apiKey: string;
  /** Points the same client at another compatible backend (Google's endpoint, see providers/gemini.ts). */
  baseURL?: string;
}

export class OpenAICompatibleChatProvider implements ChatProvider {
  readonly providerName: string;
  readonly modelName: string;
  private readonly aiSdk: ReturnType<typeof createOpenAI>;

  constructor(config: OpenAICompatibleClientConfig & { model: string }) {
    this.providerName = config.providerName ?? "openai";
    this.modelName = config.model;
    this.aiSdk = createOpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  }

  streamChat({ systemPrompt, messages }: { systemPrompt: string; messages: ChatMessage[] }): ChatStreamResult {
    // `.chat(...)` selects Chat Completions rather than the Responses API:
    // Gemini's compatible endpoint only implements Chat Completions, and real
    // OpenAI uses the same path so both behave identically.
    const model = this.aiSdk.chat(this.modelName);
    return wrapAiSdkStream(
      () =>
        fromStreamTextResult(
          streamText({
            model,
            system: systemPrompt,
            messages,
            maxRetries: 0, // lib/ai/stream-utils.ts is the only retry layer
            onError: logStreamError(this.providerName),
          })
        ),
      { provider: this.providerName }
    );
  }
}

export class OpenAICompatibleEmbeddingsProvider implements EmbeddingsProvider {
  readonly providerName: string;
  readonly modelName: string;
  readonly dimensions: number;
  private readonly client: OpenAI;

  constructor(config: OpenAICompatibleClientConfig & { model: string; dimensions: number }) {
    this.providerName = config.providerName ?? "openai";
    this.modelName = config.model;
    this.dimensions = config.dimensions;
    // maxRetries: 0 -- lib/ai/retry.ts is the only retry layer (one backoff
    // policy, one error shape); SDK retries would stack underneath it.
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, maxRetries: 0 });
  }

  embed(texts: string[]): Promise<number[][]> {
    return embedInBatches(texts, {
      provider: this.providerName,
      batchSize: EMBEDDING_BATCH_SIZE,
      dimensions: this.dimensions,
      callBatch: async (batch) => {
        const response = await this.client.embeddings.create({
          model: this.modelName,
          input: batch,
          dimensions: this.dimensions,
        });
        // Sorted by `.index`: a compatible backend (Gemini) isn't bound by
        // OpenAI's input-order guarantee, and a misaligned chunk/vector pair
        // would be silent.
        return response.data
          .slice()
          .sort((a, b) => a.index - b.index)
          .map((item) => item.embedding);
      },
    });
  }
}
