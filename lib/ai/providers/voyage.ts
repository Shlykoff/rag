// lib/ai/providers/voyage.ts
//
// Embeddings-only adapter, used exclusively to pair with
// AnthropicChatProvider (AI_PROVIDER=anthropic) since Anthropic has no
// embeddings API of its own. Wired together in lib/ai/index.ts.

import { VoyageAIClient } from "voyageai";
import type { EmbeddingsProvider } from "../types";
import { embedInBatches } from "../embed-batch";
import { AIProviderError } from "../errors";

/** Fixed project-wide, matches pgvector's vector(1024) column -- see CLAUDE.md and document_chunks migration. Voyage does NOT support arbitrary output_dimension: voyage-3-large/voyage-4 only accept output_dimension in {256, 512, 1024, 2048} (no 1536), so 1024 -- Voyage's own default -- is the value every other provider is shortened down to as well. */
export const VOYAGE_EMBEDDING_DIMENSIONS = 1024;

/** Voyage's embed endpoint caps the input list at 128 items per request. */
const EMBEDDING_BATCH_SIZE = 100;

export interface VoyageConfig {
  apiKey: string;
  embeddingModel: string;
}

export class VoyageEmbeddingsProvider implements EmbeddingsProvider {
  readonly providerName = "voyage";
  readonly modelName: string;
  readonly dimensions = VOYAGE_EMBEDDING_DIMENSIONS;
  private readonly client: VoyageAIClient;

  constructor(config: VoyageConfig) {
    this.modelName = config.embeddingModel;
    // maxRetries: 0 -- see providers/openai.ts constructor comment: our own
    // lib/ai/retry.ts is the single retry layer for this project.
    this.client = new VoyageAIClient({ apiKey: config.apiKey, maxRetries: 0 });
  }

  async embed(texts: string[]): Promise<number[][]> {
    return embedInBatches(texts, {
      provider: this.providerName,
      batchSize: EMBEDDING_BATCH_SIZE,
      callBatch: async (batch) => {
        // inputType intentionally left unset (Voyage default: symmetric
        // embeddings). Voyage supports an asymmetric mode
        // (inputType: 'document' for ingested chunks vs 'query' for the
        // user's question) that can improve retrieval quality, but the
        // shared EmbeddingsProvider.embed(texts) contract (lib/ai/types.ts)
        // is used for both chunk ingestion (lib/ingestion/ingest.ts) and
        // query embedding (lib/retrieval/search.ts) with no way to signal
        // which one this call is -- and OpenAI/Gemini have no equivalent
        // concept via the OpenAI-compatible embeddings endpoint. Symmetric
        // mode keeps behavior identical and comparable across all three
        // providers; revisit with an optional `inputType` parameter on the
        // interface if Voyage's asymmetric mode turns out to matter for
        // retrieval quality in practice.
        const response = await this.client.embed({
          input: batch,
          model: this.modelName,
          outputDimension: this.dimensions,
        });
        const data = response.data;
        if (!data) {
          throw new AIProviderError({
            provider: this.providerName,
            kind: "unknown",
            retryable: false,
            message: `${this.providerName} embed response had no 'data' field`,
            userMessage:
              "Провайдер вернул некорректный ответ при генерации embeddings.",
          });
        }
        return data
          .slice()
          .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
          .map((item) => {
            if (!item.embedding) {
              throw new AIProviderError({
                provider: this.providerName,
                kind: "unknown",
                retryable: false,
                message: `${this.providerName} embed response item missing 'embedding'`,
                userMessage:
                  "Провайдер вернул некорректный ответ при генерации embeddings.",
              });
            }
            return item.embedding;
          });
      },
    });
  }
}
