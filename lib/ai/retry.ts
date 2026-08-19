// lib/ai/retry.ts
//
// Generic retry-with-backoff for non-streaming AI-provider calls (embedding
// requests). Streaming chat has its own retry-before-first-token variant in
// lib/ai/stream-utils.ts, because "retry the whole call" is only safe there
// before any content has reached the caller.
//
// Both the `openai` SDK and the `voyageai` SDK ship their own built-in
// retry logic -- each provider adapter disables it (`maxRetries: 0` on the
// client) so this is the *only* retry layer, with one consistent backoff
// curve and one consistent error shape (AIProviderError) regardless of
// which vendor SDK is underneath.

import { normalizeProviderError, type AIProviderError } from "./errors";

export interface RetryOptions {
  provider: string;
  /** Additional attempts after the first, i.e. total attempts = maxRetries + 1. Default 2 (=> up to 3 attempts). */
  maxRetries?: number;
  baseDelayMs?: number;
  /** Injectable for tests -- avoids real timers in unit tests exercising backoff. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Full jitter exponential backoff: baseDelay * 2^attempt, plus up to baseDelay of random jitter, so many concurrent retries don't all wake up in lockstep and hammer the provider again at the same instant. */
function backoffDelayMs(attempt: number, baseDelayMs: number): number {
  return baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs;
}

/**
 * Retries `fn` on retryable AIProviderErrors (429 rate limits, 5xx, network
 * failures) with exponential backoff + jitter. Non-retryable errors (4xx
 * other than 429) are thrown immediately, on the first attempt.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 2;
  const baseDelayMs = opts.baseDelayMs ?? 300;
  const sleep = opts.sleep ?? defaultSleep;

  let lastError: AIProviderError | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (rawErr) {
      const err = normalizeProviderError(rawErr, opts.provider);
      lastError = err;
      const isLastAttempt = attempt === maxRetries;
      if (!err.retryable || isLastAttempt) throw err;
      await sleep(backoffDelayMs(attempt, baseDelayMs));
    }
  }
  // Unreachable (the loop always either returns or throws), but keeps
  // TypeScript's control-flow analysis happy without a non-null assertion.
  throw lastError ?? new Error("withRetry: exhausted attempts without an error");
}
