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

/** Raw usage shape this project accepts from either AI SDK v4-style (`promptTokens`/`completionTokens`) or v5-style (`inputTokens`/`outputTokens`) provider results -- see normalizeUsage below. */
export interface RawStreamUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
}

/**
 * Structural subset of the Vercel AI SDK's StreamTextResult that this
 * wrapper needs -- kept minimal and duck-typed so provider adapters don't
 * fight generic type params when calling this. `usage`/`text` are typed as
 * `PromiseLike` (the weaker of the two, since every `Promise` is a
 * `PromiseLike`) because that's what StreamTextResult itself exposes, so
 * this accepts a real StreamTextResult unchanged while also working with
 * plain `Promise`s in tests.
 */
export interface AiSdkStreamLike {
  textStream: AsyncIterable<string>;
  usage: PromiseLike<RawStreamUsage>;
  text: PromiseLike<string>;
}

/** The subset of a Vercel AI SDK streamText() `fullStream` part this module reads. */
export interface FullStreamPartLike {
  type: string;
  text?: string;
  error?: unknown;
}

/** Structural subset of the Vercel AI SDK's StreamTextResult that fromStreamTextResult() needs. */
export interface StreamTextResultLike {
  fullStream: AsyncIterable<FullStreamPartLike>;
  usage: PromiseLike<RawStreamUsage>;
  text: PromiseLike<string>;
}

async function* textDeltasOrThrow(fullStream: AsyncIterable<FullStreamPartLike>): AsyncGenerator<string> {
  for await (const part of fullStream) {
    if (part.type === "text-delta" && part.text) yield part.text;
    else if (part.type === "error") throw part.error;
  }
}

/**
 * Adapts a streamText() result for wrapAiSdkStream(). The SDK's own
 * `textStream` silently drops error parts, so a failed request looks like an
 * empty successful stream and nothing gets retried or classified; reading
 * `fullStream` and throwing on its `error` part fixes that. `usage`/`text`
 * stay lazy getters: the SDK only creates those promises when first read, so
 * a discarded (retried) attempt never leaves a rejected promise unhandled.
 */
export function fromStreamTextResult(result: StreamTextResultLike): AiSdkStreamLike {
  return {
    textStream: textDeltasOrThrow(result.fullStream),
    get usage() {
      return result.usage;
    },
    get text() {
      return result.text;
    },
  };
}

/**
 * streamText()'s default onError prints the raw error object, which carries
 * the whole request body (system prompt + retrieved document text). Log the
 * normalized one-line message instead.
 */
export function logStreamError(provider: string): (event: { error: unknown }) => void {
  return ({ error }) => {
    console.error(`${provider} chat stream error: ${normalizeProviderError(error, provider).message}`);
  };
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

  // `usage`/`text` reject whenever `committed` rejects (stream failed
  // before/at commit). Callers that only care about the streamed text
  // (e.g. lib/chat/handle-chat-request.ts on its error path) legitimately
  // never attach a handler to these, and Node's `--unhandled-rejections=throw`
  // would crash the whole process for an unhandled rejection. `.catch(() =>
  // {})` here just registers an extra listener to mark the promise
  // "handled" -- it doesn't mutate or replace it, so the `usage`/`text`
  // returned below still reject with the real AIProviderError for any
  // caller that does `await stream.usage`.
  usage.catch(() => {});
  text.catch(() => {});

  return { textStream, usage, text };
}
