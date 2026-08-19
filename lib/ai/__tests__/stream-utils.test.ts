import { describe, expect, it, vi } from "vitest";
import { wrapAiSdkStream, type AiSdkStreamLike } from "../stream-utils";

async function drain(stream: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

async function* asyncGen(items: string[]): AsyncGenerator<string> {
  for (const item of items) yield item;
}

function makeStream(chunks: string[], usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 }): AiSdkStreamLike {
  return {
    textStream: asyncGen(chunks),
    usage: Promise.resolve(usage),
    text: Promise.resolve(chunks.join("")),
  };
}

/**
 * A rejected placeholder for a mock's `usage`/`text` field on a failing
 * attempt. wrapAiSdkStream never actually reads `.usage`/`.text` on a
 * discarded/failed attempt (only `committed.then(...)` matters -- see
 * stream-utils.ts), so these are only ever there to satisfy the
 * AiSdkStreamLike shape. Without the eager `.catch(() => {})` here, Node
 * flags them as unhandled promise rejections and fails the test run even
 * though production code correctly never touches them on this path.
 */
function neverConsumed<T = never>(message: string): Promise<T> {
  const rejected = Promise.reject(new Error(message)) as Promise<T>;
  rejected.catch(() => {});
  return rejected;
}

describe("wrapAiSdkStream", () => {
  it("passes through chunks, usage and text on a clean success", async () => {
    const makeResult = vi.fn().mockReturnValue(makeStream(["Hel", "lo"]));
    const result = wrapAiSdkStream(makeResult, { provider: "openai", sleep: async () => {} });
    const chunks = await drain(result.textStream);
    expect(chunks).toEqual(["Hel", "lo"]);
    expect(await result.text).toBe("Hello");
    expect(await result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(makeResult).toHaveBeenCalledTimes(1);
  });

  it("normalizes AI SDK v5-style usage field names (inputTokens/outputTokens) to promptTokens/completionTokens", async () => {
    const makeResult = vi.fn().mockReturnValue({
      textStream: asyncGen(["hi"]),
      usage: Promise.resolve({ inputTokens: 7, outputTokens: 3, totalTokens: 10 }),
      text: Promise.resolve("hi"),
    } satisfies AiSdkStreamLike);
    const result = wrapAiSdkStream(makeResult, { provider: "openai", sleep: async () => {} });
    await drain(result.textStream);
    expect(await result.usage).toEqual({ promptTokens: 7, completionTokens: 3, totalTokens: 10 });
  });

  it("retries a failure that happens before any chunk is yielded (e.g. 429 on connect)", async () => {
    let attempt = 0;
    const makeResult = vi.fn().mockImplementation(() => {
      attempt++;
      if (attempt === 1) {
        return {
          textStream: (async function* () {
            throw { status: 429 };
          })(),
          usage: neverConsumed("never consumed"),
          text: neverConsumed("never consumed"),
        } satisfies AiSdkStreamLike;
      }
      return makeStream(["recovered"]);
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = wrapAiSdkStream(makeResult, { provider: "openai", sleep });
    const chunks = await drain(result.textStream);
    expect(chunks).toEqual(["recovered"]);
    expect(makeResult).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry once a chunk has already been yielded -- propagates the mid-stream error instead", async () => {
    const makeResult = vi.fn().mockImplementation(() => ({
      textStream: (async function* () {
        yield "partial ";
        throw { status: 500 };
      })(),
      usage: neverConsumed("never consumed"),
      text: neverConsumed("never consumed"),
    } satisfies AiSdkStreamLike));
    const result = wrapAiSdkStream(makeResult, { provider: "openai", sleep: async () => {} });
    // usage/text derive from the same rejected `committed` internal
    // promise and are intentionally not asserted on in this test -- attach
    // a no-op handler so Node doesn't flag them as unhandled rejections.
    result.usage.catch(() => {});
    result.text.catch(() => {});

    const chunks: string[] = [];
    // Note: pass an already-invoked promise, not the async function
    // itself, to `expect(...).rejects` -- passing the function risks it
    // being invoked more than once by the matcher, which would push to
    // `chunks` multiple times and make this assertion flaky.
    const consume = (async () => {
      for await (const chunk of result.textStream) chunks.push(chunk);
    })();
    await expect(consume).rejects.toMatchObject({ kind: "server_error" });

    expect(chunks).toEqual(["partial "]);
    expect(makeResult).toHaveBeenCalledTimes(1); // never restarted
  });

  it("gives up after maxRetries on a persistently failing connect and rejects usage/text too", async () => {
    const makeResult = vi.fn().mockImplementation(() => ({
      textStream: (async function* () {
        throw { status: 503 };
      })(),
      usage: neverConsumed("never consumed"),
      text: neverConsumed("never consumed"),
    } satisfies AiSdkStreamLike));
    const result = wrapAiSdkStream(makeResult, {
      provider: "anthropic",
      sleep: async () => {},
      maxRetries: 2,
    });

    await expect(drain(result.textStream)).rejects.toMatchObject({ kind: "server_error" });
    expect(makeResult).toHaveBeenCalledTimes(3); // initial + 2 retries
    await expect(result.usage).rejects.toBeTruthy();
    await expect(result.text).rejects.toBeTruthy();
  });

  it("never produces an unhandled promise rejection when a caller drains textStream, catches the error, and never touches usage/text -- the real lib/chat/handle-chat-request.ts error path (Bug 1 regression test)", async () => {
    // Deliberately mirrors handle-chat-request.ts's actual error handling
    // (see its `catch (rawErr) { ...; yield {type:'error',...}; return; }`
    // block) with NO `.catch()`/`.then()` ever attached to
    // `result.usage`/`result.text` by this test -- that's the whole point:
    // before the fix, wrapAiSdkStream() derived usage/text from `committed`
    // with no internal safeguard, so this exact call pattern left both
    // promises unhandled once `committed` rejected. Under Node's default
    // `--unhandled-rejections=throw` (Node 15+) that crashes the process;
    // under Vitest it fails the whole test run even though this specific
    // test's assertions all pass. If this test is green and the run
    // doesn't blow up, the internal `.catch(() => {})` in wrapAiSdkStream
    // is doing its job.
    const makeResult = vi.fn().mockImplementation(() => ({
      textStream: (async function* () {
        throw { status: 500 };
      })(),
      usage: neverConsumed("never consumed"),
      text: neverConsumed("never consumed"),
    } satisfies AiSdkStreamLike));
    const result = wrapAiSdkStream(makeResult, {
      provider: "openai",
      sleep: async () => {},
      maxRetries: 0,
    });

    let caught: unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- draining the stream is the point of the test, the chunk value itself is irrelevant (never reached anyway)
      for await (const chunk of result.textStream) {
        // never reached
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ kind: "server_error" });
    // Intentionally: no `await result.usage` / `await result.text` here,
    // and no `.catch()` on them either -- see the comment above.
  });

  it("does not retry a non-retryable error even before any chunk was yielded", async () => {
    const makeResult = vi.fn().mockImplementation(() => ({
      textStream: (async function* () {
        throw { status: 400 };
      })(),
      usage: neverConsumed("never consumed"),
      text: neverConsumed("never consumed"),
    } satisfies AiSdkStreamLike));
    const result = wrapAiSdkStream(makeResult, { provider: "openai", sleep: async () => {} });
    result.usage.catch(() => {});
    result.text.catch(() => {});
    await expect(drain(result.textStream)).rejects.toMatchObject({ kind: "invalid_request" });
    expect(makeResult).toHaveBeenCalledTimes(1);
  });
});
