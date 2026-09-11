import { describe, expect, it } from "vitest";
import { streamText } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { fromStreamTextResult, wrapAiSdkStream } from "../stream-utils";

// Runs the real streamText() against a mock model rather than a hand-written
// fake stream: the bug guarded here is in how the SDK reports errors (its
// textStream silently drops them), which a fake stream can't reproduce.

const USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
};

function textStreamResult(deltas: string[]) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "t1" },
        ...deltas.map((delta) => ({ type: "text-delta" as const, id: "t1", delta })),
        { type: "text-end" as const, id: "t1" },
        { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage: USAGE },
      ],
    }),
  };
}

function httpError(statusCode: number): Error {
  return Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
}

function run(model: MockLanguageModelV4, maxRetries = 2) {
  return wrapAiSdkStream(
    () => fromStreamTextResult(streamText({ model, prompt: "question", maxRetries: 0, onError: () => {} })),
    { provider: "mock", sleep: async () => {}, maxRetries }
  );
}

async function drain(stream: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("wrapAiSdkStream + fromStreamTextResult with the real streamText()", () => {
  it("streams text and reports usage on success", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => textStreamResult(["Hel", "lo"]) });

    const result = run(model);

    expect(await drain(result.textStream)).toEqual(["Hel", "lo"]);
    expect(await result.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  });

  it("retries a provider error raised before the first token", async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls++;
        if (calls === 1) throw httpError(429);
        return textStreamResult(["recovered"]);
      },
    });

    const result = run(model);

    expect(await drain(result.textStream)).toEqual(["recovered"]);
    expect(calls).toBe(2);
  });

  it("surfaces a non-retryable provider error as an AIProviderError instead of an empty answer", async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls++;
        throw httpError(401);
      },
    });

    const result = run(model);

    await expect(drain(result.textStream)).rejects.toMatchObject({ kind: "invalid_request", status: 401 });
    expect(calls).toBe(1);
  });

  it("surfaces an error part emitted inside the stream", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start" as const, warnings: [] },
            { type: "error" as const, error: httpError(500) },
          ],
        }),
      }),
    });

    const result = run(model, 0);

    await expect(drain(result.textStream)).rejects.toMatchObject({ kind: "server_error", status: 500 });
  });
});
