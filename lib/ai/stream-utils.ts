// lib/ai/stream-utils.ts
//
// Shared retry-before-first-token logic used by every chat provider adapter
// (openai.ts, anthropic.ts, and gemini.ts which reuses openai.ts). Wraps a
// Vercel AI SDK `streamText(...)` result (or anything with the same
// textStream/usage/text shape) into this project's provider-agnostic
// ChatStreamResult (lib/ai/types.ts).
//
// Retry semantics: if the underlying request fails (429/5xx/network) before
// a single text delta has reached the caller, the whole request is retried
// from scratch with backoff (`makeResult()` called again). Once one chunk
// has been yielded we commit to that attempt and never retry -- restarting
// mid-stream would duplicate or garble output the caller/UI may have
// already rendered downstream.

import { normalizeProviderError } from "./errors";
import type { ChatStreamResult, TokenUsage } from "./types";

/**
 * Structural subset of the Vercel AI SDK's StreamTextResult that this
 * wrapper needs -- kept minimal and duck-typed so provider adapters don't
 * have to fight generic type params when calling this. `usage`/`text` are
 * typed as `PromiseLike` (not `Promise`) because that's what
 * StreamTextResult itself exposes them as -- `PromiseLike` is the weaker
 * type (every `Promise` is a `PromiseLike`, not vice versa), so this still
 * accepts a real StreamTextResult unchanged while remaining fully usable
 * with plain `Promise`s (including in tests, see stream-utils.test.ts).
 */
/** Raw usage shape this project accepts from either AI SDK v4-style (`promptTokens`/`completionTokens`) or v5-style (`inputTokens`/`outputTokens`) provider results -- see normalizeUsage below. */
export interface RawStreamUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
}

export interface AiSdkStreamLike {
  textStream: AsyncIterable<string>;
  usage: PromiseLike<RawStreamUsage>;
  text: PromiseLike<string>;
}

export interface StreamRetryOptions {
  provider: string;
  maxRetries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function backoffDelayMs(attempt: number, baseDelayMs: number): number {
  return baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs;
}

function normalizeUsage(raw: RawStreamUsage): TokenUsage {
  const promptTokens = raw.promptTokens ?? raw.inputTokens ?? 0;
  const completionTokens = raw.completionTokens ?? raw.outputTokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: raw.totalTokens ?? promptTokens + completionTokens,
  };
}

export function wrapAiSdkStream(
  makeResult: () => AiSdkStreamLike,
  opts: StreamRetryOptions
): ChatStreamResult {
  const maxRetries = opts.maxRetries ?? 2;
  const baseDelayMs = opts.baseDelayMs ?? 300;
  const sleep = opts.sleep ?? defaultSleep;

  // Resolves once we're committed to a specific attempt's `result` (either
  // it yielded at least one chunk, or it completed as a legitimately empty
  // stream). usage/text below read from this rather than from `makeResult()`
  // directly, so they can never resolve against an attempt that was
  // discarded and retried.
  let resolveCommitted!: (result: AiSdkStreamLike) => void;
  let rejectCommitted!: (err: unknown) => void;
  const committed = new Promise<AiSdkStreamLike>((resolve, reject) => {
    resolveCommitted = resolve;
    rejectCommitted = reject;
  });

  async function* run(): AsyncGenerator<string> {
    let attempt = 0;
    for (;;) {
      const result = makeResult();
      let yieldedAny = false;
      try {
        for await (const delta of result.textStream) {
          if (!yieldedAny) {
            yieldedAny = true;
            resolveCommitted(result);
          }
          yield delta;
        }
        if (!yieldedAny) resolveCommitted(result); // empty-but-successful stream: still a valid, final outcome
        return;
      } catch (rawErr) {
        const err = normalizeProviderError(rawErr, opts.provider);
        // Once a chunk has reached the caller we are committed to this
        // attempt no matter what: restarting mid-stream would duplicate or
        // garble output the caller may already have rendered. Only a
        // failure before the very first chunk is eligible for retry.
        if (yieldedAny || !err.retryable || attempt >= maxRetries) {
          rejectCommitted(err);
          throw err;
        }
        attempt++;
        await sleep(backoffDelayMs(attempt - 1, baseDelayMs));
        // loop: call makeResult() again for a fresh attempt
      }
    }
  }

  const textStream = run();

  const usage: Promise<TokenUsage> = committed.then(async (result) => {
    const raw = await result.usage;
    return normalizeUsage(raw);
  });

  const text: Promise<string> = committed.then((result) => result.text);

  // `usage`/`text` reject whenever `committed` rejects (i.e. the stream
  // failed before/at commit -- see `run()` above). Callers that only care
  // about the streamed text (the common case: lib/chat/handle-chat-request.ts
  // yields an SSE error event and returns without ever touching
  // `.usage`/`.text` on the failure path) legitimately never attach a
  // handler to these promises. Node's `--unhandled-rejections=throw`
  // (default since Node 15) crashes the whole process for ANY rejected
  // promise nobody ever handled, which would take down every in-flight
  // request for every user over one AI-provider error.
  //
  // Attaching `.catch(() => {})` here registers a handler directly on the
  // `usage`/`text` promises themselves -- calling `.catch()` never mutates
  // or replaces the original promise, it just adds one more independent
  // listener (the same way `await`-ing a promise twice, or passing it to
  // two different callers, works fine and each caller still observes the
  // real rejection). So this line exists purely to mark `usage`/`text` as
  // "handled" for Node's unhandled-rejection tracking; the caller-facing
  // `usage`/`text` returned below are untouched and still reject with the
  // real AIProviderError if a caller does `await stream.usage`.
  usage.catch(() => {});
  text.catch(() => {});

  return { textStream, usage, text };
}
