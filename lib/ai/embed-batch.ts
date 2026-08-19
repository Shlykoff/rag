// lib/ai/embed-batch.ts
//
// Shared batching + partial-failure handling for EmbeddingsProvider.embed()
// implementations (openai.ts, voyage.ts, and gemini.ts which reuses
// openai.ts). Used instead of embedding one chunk per API call, per
// CLAUDE.md's "батчами (не по одному чанку за вызов API)" requirement.
//
// Partial batch failure handling: embedding endpoints are all-or-nothing
// per HTTP call -- a single malformed/oversized input makes the *whole*
// batch request fail, even though every other input in that batch was
// fine. If that happened while embedding e.g. 100 chunks in one call, a
// naive implementation would fail the entire document just because of one
// chunk. Instead, on a batch failure we bisect the batch into two halves
// and retry each independently, narrowing down to the specific input(s)
// that fail even in isolation. Every other input still gets embedded
// normally. If bisection ultimately isolates one or more permanently
// failing inputs, we don't silently drop them (that would break the 1:1
// alignment between the returned array and document_chunks.chunk_index
// that lib/ingestion/ingest.ts depends on) -- we surface a single
// aggregate AIProviderError naming which index/indices failed, so the
// ingestion pipeline can record a precise processing_error.

import { AIProviderError, normalizeProviderError } from "./errors";
import { withRetry, type RetryOptions } from "./retry";

export interface EmbedBatchDeps {
  provider: string;
  /** Max inputs per underlying API call (e.g. 100 for OpenAI, <=128 for Voyage). */
  batchSize: number;
  /** Performs one API call for `batch`, returning vectors in the same order as `batch`. Throws on failure (any shape -- normalized internally). */
  callBatch: (batch: string[]) => Promise<number[][]>;
  /** Forwarded to withRetry for each batch/sub-batch attempt. */
  sleep?: RetryOptions["sleep"];
  maxRetries?: RetryOptions["maxRetries"];
}

export async function embedInBatches(
  texts: string[],
  deps: EmbedBatchDeps
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const results = new Array<number[] | undefined>(texts.length);
  const failures: Array<{ index: number; error: AIProviderError }> = [];

  async function processRange(start: number, end: number): Promise<void> {
    // `end` is exclusive.
    const batch = texts.slice(start, end);
    try {
      const vectors = await withRetry(() => deps.callBatch(batch), {
        provider: deps.provider,
        sleep: deps.sleep,
        maxRetries: deps.maxRetries,
      });
      if (vectors.length !== batch.length) {
        throw new AIProviderError({
          provider: deps.provider,
          kind: "unknown",
          retryable: false,
          message: `${deps.provider} embeddings call returned ${vectors.length} vectors for ${batch.length} inputs (index range [${start}, ${end}))`,
          userMessage:
            "Провайдер вернул некорректный ответ при генерации embeddings.",
        });
      }
      vectors.forEach((vector, i) => {
        results[start + i] = vector;
      });
    } catch (rawErr) {
      const err = normalizeProviderError(rawErr, deps.provider);
      if (end - start <= 1) {
        // Bisection bottomed out: this single input fails on its own.
        failures.push({ index: start, error: err });
        return;
      }
      const mid = start + Math.ceil((end - start) / 2);
      await processRange(start, mid);
      await processRange(mid, end);
    }
  }

  for (let start = 0; start < texts.length; start += deps.batchSize) {
    await processRange(start, Math.min(start + deps.batchSize, texts.length));
  }

  if (failures.length > 0) {
    const indices = failures.map((f) => f.index).join(", ");
    const first = failures[0];
    throw new AIProviderError({
      provider: deps.provider,
      kind: first.error.kind,
      status: first.error.status,
      retryable: false,
      cause: first.error,
      message: `${deps.provider} failed to embed ${failures.length} of ${texts.length} input(s) at index/indices [${indices}]: ${first.error.message}`,
      userMessage:
        "Не удалось сгенерировать embeddings для части документа.",
    });
  }

  return results as number[][];
}
