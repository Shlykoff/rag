// lib/ai/providers/voyage.ts
//
// Embeddings-only adapter. Anthropic has no embeddings API, so Voyage is the
// embedding option for an account that only has Claude for chat; any
// embedding model can pair with any chat model (see lib/ai/index.ts).
// The voyage-4 family only accepts outputDimension in {256, 512, 1024, 2048},
// so catalog rows for Voyage must use one of those.

import { VoyageAIClient } from "voyageai";
import type { EmbeddingsProvider } from "../types";
import { embedInBatches } from "../embed-batch";
import { AIProviderError } from "../errors";

/** Voyage's embed endpoint caps the input list at 128 items per request. */
const EMBEDDING_BATCH_SIZE = 100;

export interface VoyageConfig {
  apiKey: string;
  model: string;
  dimensions: number;
}

function malformedResponse(provider: string, message: string): AIProviderError {
  return new AIProviderError({
    provider,
    kind: "unknown",
    retryable: false,
    message: `${provider} ${message}`,
    userMessage: "Провайдер вернул некорректный ответ при генерации embeddings.",
  });
}

export class VoyageEmbeddingsProvider implements EmbeddingsProvider {
  readonly providerName = "voyage";
  readonly modelName: string;
  readonly dimensions: number;
  private readonly client: VoyageAIClient;

  constructor(config: VoyageConfig) {
    this.modelName = config.model;
    this.dimensions = config.dimensions;
    // maxRetries: 0 -- lib/ai/retry.ts is the only retry layer.
    this.client = new VoyageAIClient({ apiKey: config.apiKey, maxRetries: 0 });
  }

  embed(texts: string[]): Promise<number[][]> {
    return embedInBatches(texts, {
      provider: this.providerName,
      batchSize: EMBEDDING_BATCH_SIZE,
      dimensions: this.dimensions,
      callBatch: async (batch) => {
        // inputType is left unset (symmetric embeddings): EmbeddingsProvider
        // .embed() serves both chunk ingestion and query embedding with no
        // way to tell them apart, and OpenAI/Gemini have no equivalent
        // through the compatible endpoint. Revisit with an optional
        // `inputType` on the interface if asymmetric mode proves worth it.
        const response = await this.client.embed({
          input: batch,
          model: this.modelName,
          outputDimension: this.dimensions,
        });
        const data = response.data;
        if (!data) throw malformedResponse(this.providerName, "embed response had no 'data' field");
        return data
          .slice()
          .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
          .map((item) => {
            if (!item.embedding) throw malformedResponse(this.providerName, "embed response item missing 'embedding'");
            return item.embedding;
          });
      },
    });
  }
}
