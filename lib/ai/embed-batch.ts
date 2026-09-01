// lib/ai/embed-batch.ts
//
// Shared batching + partial-failure handling for EmbeddingsProvider.embed()
// implementations (openai.ts, voyage.ts, and gemini.ts which reuses
// openai.ts). Used instead of embedding one chunk per API call, per
// CLAUDE.md's batching requirement.
//
// Partial batch failure handling: embedding endpoints are all-or-nothing
// per HTTP call -- one malformed/oversized input fails the whole batch even
// though every other input was fine. On a batch failure we bisect into two
// halves and retry each independently, narrowing down to the specific
// input(s) that fail even in isolation; everything else still embeds
// normally. Failing inputs are never silently dropped (that would break the
// 1:1 alignment between the returned array and document_chunks.chunk_index
// that lib/ingestion/ingest.ts depends on) -- a single aggregate
// AIProviderError names which index/indices failed.
//
// Fail-fast exception to bisection: a systemic failure (bad API key,
// unknown model id -- see isSystemicBatchFailure()) affects the whole
// request, not a specific input. Bisecting one of those down to single-item
// calls would just repeat the identical failure O(batchSize) times for no
// benefit, so it's detected and short-circuited before recursing further.

import { AIProviderError, normalizeProviderError } from "./errors";
import { withRetry, type RetryOptions } from "./retry";

export interface EmbedBatchDeps {
  provider: string;
  /** Max inputs per underlying API call (e.g. 100 for OpenAI, <=128 for Voyage). */
  batchSize: number;
  /** Expected length of every returned embedding vector (fixed project-wide at 1024, see lib/ai/types.ts's EmbeddingsProvider doc comment) -- validated against every vector callBatch returns, not just the vector COUNT, so a vendor silently returning the wrong-sized vector fails loudly here instead of surfacing many layers away as a raw Postgres `vector(1024)` mismatch. */
  dimensions: number;
  /** Performs one API call for `batch`, returning vectors in the same order as `batch`. Throws on failure (any shape -- normalized internally). */
  callBatch: (batch: string[]) => Promise<number[][]>;
  /** Forwarded to withRetry for each batch/sub-batch attempt. */
  sleep?: RetryOptions["sleep"];
  maxRetries?: RetryOptions["maxRetries"];
}

/**
 * True for a normalized error that reflects a whole-request condition
 * (invalid/missing credentials, or an unknown model id) rather than a
 * problem with a specific input. 401/403 (bad/missing API key) and 404
 * (unknown model id) are the common real-world codes for this. A plain 400
 * is deliberately excluded -- that's also the shape of a genuine per-item
 * problem (e.g. "input too long" for one oversized chunk), which is exactly
 * what bisection exists to isolate, so a bare 400 still gets bisected.
 */
function isSystemicBatchFailure(err: AIProviderError): boolean {
  return err.status === 401 || err.status === 403 || err.status === 404;
}

/** How many top-level batches run concurrently -- see the loop below for why this isn't unbounded. */
const MAX_CONCURRENT_BATCHES = 5;

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
      // Per-vector length check -- see EmbedBatchDeps.dimensions's own doc
      // comment for why this is checked here (the earliest point any
      // caller can) rather than left to surface as a pgvector insert
      // failure many layers away.
      const badIndex = vectors.findIndex((vector) => vector.length !== deps.dimensions);
      if (badIndex !== -1) {
        throw new AIProviderError({
          provider: deps.provider,
          kind: "unknown",
          retryable: false,
          message: `${deps.provider} embeddings call returned a vector of length ${vectors[badIndex].length} at index ${start + badIndex} (range [${start}, ${end})), expected ${deps.dimensions}`,
          userMessage:
            "Провайдер вернул embeddings неожиданной размерности.",
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
      if (isSystemicBatchFailure(err)) {
        // Whole-request failure (bad credentials/unknown model), not a
        // per-item problem -- bisecting further would just reproduce the
        // exact same failure for every sub-batch, wasting O(batchSize)
        // calls to learn nothing new. Fail every index in this range at
        // once instead, with no further API calls.
        for (let i = start; i < end; i++) {
          failures.push({ index: i, error: err });
        }
        return;
      }
      const mid = start + Math.ceil((end - start) / 2);
      await processRange(start, mid);
      await processRange(mid, end);
    }
  }

  // Batches are independent HTTP calls (disjoint `texts` slices, writing to
  // disjoint slots of `results`/`failures`), so there's no correctness
  // reason to run them sequentially -- but an unbounded `Promise.all` risks
  // tripping the embeddings vendor's own per-account concurrency/rate
  // limits (distinct from lib/rate-limit/'s app-level limiters, which bound
  // how often a caller can trigger an ingest, not how many concurrent calls
  // one ingest fans out into). A small fixed-size worker pool keeps a large
  // document embedding meaningfully faster than sequential while staying
  // under realistic vendor concurrency limits.
  const batchStarts: number[] = [];
  for (let start = 0; start < texts.length; start += deps.batchSize) batchStarts.push(start);

  let nextBatch = 0;
  async function worker(): Promise<void> {
    while (nextBatch < batchStarts.length) {
      const start = batchStarts[nextBatch++];
      await processRange(start, Math.min(start + deps.batchSize, texts.length));
    }
  }
  const workerCount = Math.min(MAX_CONCURRENT_BATCHES, batchStarts.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

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
