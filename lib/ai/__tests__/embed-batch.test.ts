import { describe, expect, it, vi } from "vitest";
import { embedInBatches } from "../embed-batch";
import { AIProviderError } from "../errors";

const sleep = async () => {}; // no real delays in tests

function fakeVector(seed: number): number[] {
  return [seed, seed + 1, seed + 2];
}

describe("embedInBatches", () => {
  it("returns an empty array for empty input without calling the API", async () => {
    const callBatch = vi.fn();
    const result = await embedInBatches([], { provider: "openai", batchSize: 10, callBatch, sleep });
    expect(result).toEqual([]);
    expect(callBatch).not.toHaveBeenCalled();
  });

  it("splits input into batches of the configured size and preserves order", async () => {
    const texts = Array.from({ length: 25 }, (_, i) => `chunk-${i}`);
    const callBatch = vi.fn().mockImplementation(async (batch: string[]) =>
      batch.map((t) => fakeVector(Number(t.split("-")[1])))
    );
    const result = await embedInBatches(texts, { provider: "openai", batchSize: 10, callBatch, sleep });
    expect(result).toHaveLength(25);
    expect(result[0]).toEqual(fakeVector(0));
    expect(result[24]).toEqual(fakeVector(24));
    // 25 inputs / batchSize 10 -> 3 calls (10, 10, 5)
    expect(callBatch).toHaveBeenCalledTimes(3);
    expect(callBatch.mock.calls[0][0]).toHaveLength(10);
    expect(callBatch.mock.calls[2][0]).toHaveLength(5);
  });

  it("retries a transient batch failure and still succeeds", async () => {
    let attempts = 0;
    const callBatch = vi.fn().mockImplementation(async (batch: string[]) => {
      attempts++;
      if (attempts === 1) throw { status: 429 };
      return batch.map((_, i) => fakeVector(i));
    });
    const result = await embedInBatches(["a", "b"], { provider: "openai", batchSize: 10, callBatch, sleep });
    expect(result).toHaveLength(2);
    expect(attempts).toBe(2);
  });

  it("bisects a batch to isolate a single permanently-bad input, embedding everything else", async () => {
    const texts = ["good-0", "good-1", "BAD", "good-3"];
    const callBatch = vi.fn().mockImplementation(async (batch: string[]) => {
      if (batch.includes("BAD")) {
        // Whole-request failure, as real embedding APIs behave: one bad
        // input fails the entire batch call, not just its own slot.
        throw { status: 400, message: "input too long" };
      }
      return batch.map((t) => fakeVector(texts.indexOf(t)));
    });
    await expect(
      embedInBatches(texts, { provider: "openai", batchSize: 4, callBatch, sleep })
    ).rejects.toMatchObject({ message: expect.stringContaining("index/indices [2]") });

    // The bisection must have still embedded the 3 good inputs via smaller
    // sub-batches that don't contain "BAD" -- verify by checking callBatch
    // was invoked with sub-ranges, not just the one big failing batch.
    const allBatches = callBatch.mock.calls.map((c) => c[0] as string[]);
    expect(allBatches).toContainEqual(["good-0", "good-1"]);
    expect(allBatches).toContainEqual(["good-3"]);
  });

  it("throws an AIProviderError (not a generic Error) when a batch is permanently unrecoverable", async () => {
    const callBatch = vi.fn().mockRejectedValue({ status: 400, message: "invalid" });
    await expect(
      embedInBatches(["only-one"], { provider: "openai", batchSize: 10, callBatch, sleep })
    ).rejects.toBeInstanceOf(AIProviderError);
  });

  it("treats a length mismatch between input and returned vectors as a failure for that batch", async () => {
    // batchSize: 1 so each call is already a single-item range -- bisection
    // has nothing left to subdivide, isolating the mismatch directly
    // instead of "self-healing" it by retrying at a smaller size.
    const callBatch = vi.fn().mockResolvedValue([]); // returns 0 vectors for 1 input
    await expect(
      embedInBatches(["a", "b"], { provider: "openai", batchSize: 1, callBatch, sleep })
    ).rejects.toBeInstanceOf(AIProviderError);
  });
});
