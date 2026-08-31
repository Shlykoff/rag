import { describe, expect, it, vi } from "vitest";
import { embedInBatches } from "../embed-batch";
import { AIProviderError } from "../errors";

const sleep = async () => {}; // no real delays in tests
const DIMENSIONS = 3; // matches fakeVector()'s length below

function fakeVector(seed: number): number[] {
  return [seed, seed + 1, seed + 2];
}

describe("embedInBatches", () => {
  it("returns an empty array for empty input without calling the API", async () => {
    const callBatch = vi.fn();
    const result = await embedInBatches([], { provider: "openai", batchSize: 10, dimensions: DIMENSIONS, callBatch, sleep });
    expect(result).toEqual([]);
    expect(callBatch).not.toHaveBeenCalled();
  });

  it("splits input into batches of the configured size and preserves order", async () => {
    const texts = Array.from({ length: 25 }, (_, i) => `chunk-${i}`);
    const callBatch = vi.fn().mockImplementation(async (batch: string[]) =>
      batch.map((t) => fakeVector(Number(t.split("-")[1])))
    );
    const result = await embedInBatches(texts, { provider: "openai", batchSize: 10, dimensions: DIMENSIONS, callBatch, sleep });
    expect(result).toHaveLength(25);
    expect(result[0]).toEqual(fakeVector(0));
    expect(result[24]).toEqual(fakeVector(24));
    // 25 inputs / batchSize 10 -> 3 calls (10, 10, 5)
    expect(callBatch).toHaveBeenCalledTimes(3);
    expect(callBatch.mock.calls[0][0]).toHaveLength(10);
    expect(callBatch.mock.calls[2][0]).toHaveLength(5);
  });

  // Yields to the macrotask queue -- Node fully drains the microtask queue
  // (including microtasks newly enqueued by resolving promises DURING that
  // drain) before running the next macrotask/timer, so one `setTimeout`
  // tick is enough to let an entire chain of `.then`-continuations
  // (release a batch -> withRetry resumes -> processRange finishes ->
  // worker() loops -> calls callBatch for its NEXT batch) fully settle,
  // regardless of how many microtask hops are in that chain.
  const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("runs multiple batches concurrently rather than strictly sequentially", async () => {
    // 12 inputs / batchSize 2 -> 6 batches, well under the internal
    // concurrency cap -- if these ran one at a time, `inFlight` would never
    // exceed 1. Each callBatch call blocks until released, so this proves
    // more than one batch is genuinely in flight at once. No `await` is
    // needed before the first assertion: constructing the worker pool
    // (Array.from(...).map(() => worker())) calls each worker synchronously
    // up to its own first genuinely-pending await (inside callBatch's
    // Promise executor, which itself runs synchronously) -- so by the time
    // `embedInBatches(...)` returns control to this test, every initial
    // worker has already registered its callBatch call.
    const texts = Array.from({ length: 12 }, (_, i) => `chunk-${i}`);
    let inFlight = 0;
    let maxInFlight = 0;
    const releases: Array<() => void> = [];
    const callBatch = vi.fn().mockImplementation(
      (batch: string[]) =>
        new Promise<number[][]>((resolve) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          releases.push(() => {
            inFlight--;
            resolve(batch.map((_, i) => fakeVector(i)));
          });
        })
    );

    const resultPromise = embedInBatches(texts, { provider: "openai", batchSize: 2, dimensions: DIMENSIONS, callBatch, sleep });

    expect(maxInFlight).toBeGreaterThan(1);

    // Release everything (in waves, since finishing a batch triggers its
    // worker to pick up the next one) so the outer promise can resolve.
    while (releases.length > 0) {
      releases.splice(0).forEach((release) => release());
      await flushMicrotasks();
    }
    await resultPromise;
  });

  it("caps concurrency instead of firing every batch at once for a large input", async () => {
    // 50 batches (batchSize 1, 50 inputs) -- if concurrency were unbounded,
    // all 50 would be in flight simultaneously; the internal cap must keep
    // this well below that.
    const texts = Array.from({ length: 50 }, (_, i) => `chunk-${i}`);
    let inFlight = 0;
    let maxInFlight = 0;
    const releases: Array<() => void> = [];
    const callBatch = vi.fn().mockImplementation(
      (batch: string[]) =>
        new Promise<number[][]>((resolve) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          releases.push(() => {
            inFlight--;
            resolve(batch.map((_, i) => fakeVector(i)));
          });
        })
    );

    const resultPromise = embedInBatches(texts, { provider: "openai", batchSize: 1, dimensions: DIMENSIONS, callBatch, sleep });

    expect(maxInFlight).toBeGreaterThan(1); // some real concurrency happened
    while (releases.length > 0) {
      releases.splice(0).forEach((release) => release());
      await flushMicrotasks();
    }
    await resultPromise;

    expect(maxInFlight).toBeLessThan(texts.length);
    expect(maxInFlight).toBeLessThanOrEqual(5);
  });

  it("retries a transient batch failure and still succeeds", async () => {
    let attempts = 0;
    const callBatch = vi.fn().mockImplementation(async (batch: string[]) => {
      attempts++;
      if (attempts === 1) throw { status: 429 };
      return batch.map((_, i) => fakeVector(i));
    });
    const result = await embedInBatches(["a", "b"], { provider: "openai", batchSize: 10, dimensions: DIMENSIONS, callBatch, sleep });
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
      embedInBatches(texts, { provider: "openai", batchSize: 4, dimensions: DIMENSIONS, callBatch, sleep })
    ).rejects.toMatchObject({ message: expect.stringContaining("index/indices [2]") });

    // The bisection must have still embedded the 3 good inputs via smaller
    // sub-batches that don't contain "BAD" -- verify by checking callBatch
    // was invoked with sub-ranges, not just the one big failing batch.
    const allBatches = callBatch.mock.calls.map((c) => c[0] as string[]);
    expect(allBatches).toContainEqual(["good-0", "good-1"]);
    expect(allBatches).toContainEqual(["good-3"]);
  });

  // Regression test for the fail-fast fix: a SYSTEMIC failure (bad
  // credentials, here modeled as a uniform 401 from every sub-batch) must
  // fail the whole range immediately instead of bisecting all the way down
  // to single-item calls -- see isSystemicBatchFailure()'s own comment.
  it("fails a whole batch immediately (no bisection) on a uniform/systemic error like a bad API key", async () => {
    const texts = ["a", "b", "c", "d"];
    const callBatch = vi.fn().mockRejectedValue({ status: 401, message: "invalid api key" });

    await expect(
      embedInBatches(texts, { provider: "openai", batchSize: 4, dimensions: DIMENSIONS, callBatch, sleep })
    ).rejects.toMatchObject({ message: expect.stringContaining("failed to embed 4 of 4 input(s)") });

    // Exactly ONE call -- bisection never kicked in, unlike the per-item
    // "BAD" test above which needs several sub-batch calls to isolate the
    // one bad input.
    expect(callBatch).toHaveBeenCalledTimes(1);
  });

  it("still bisects (does not fail-fast) for a plain 400 -- that's the per-item-shaped failure bisection exists for", async () => {
    const texts = ["good-0", "BAD", "good-2"];
    const callBatch = vi.fn().mockImplementation(async (batch: string[]) => {
      if (batch.includes("BAD")) throw { status: 400, message: "input too long" };
      return batch.map((t) => fakeVector(texts.indexOf(t)));
    });
    await expect(
      embedInBatches(texts, { provider: "openai", batchSize: 3, dimensions: DIMENSIONS, callBatch, sleep })
    ).rejects.toMatchObject({ message: expect.stringContaining("index/indices [1]") });
    // More than one call -- bisection actually ran (unlike the fail-fast case above).
    expect(callBatch.mock.calls.length).toBeGreaterThan(1);
  });

  it("throws an AIProviderError (not a generic Error) when a batch is permanently unrecoverable", async () => {
    const callBatch = vi.fn().mockRejectedValue({ status: 400, message: "invalid" });
    await expect(
      embedInBatches(["only-one"], { provider: "openai", batchSize: 10, dimensions: DIMENSIONS, callBatch, sleep })
    ).rejects.toBeInstanceOf(AIProviderError);
  });

  it("treats a length mismatch between input and returned vectors as a failure for that batch", async () => {
    // batchSize: 1 so each call is already a single-item range -- bisection
    // has nothing left to subdivide, isolating the mismatch directly
    // instead of "self-healing" it by retrying at a smaller size.
    const callBatch = vi.fn().mockResolvedValue([]); // returns 0 vectors for 1 input
    await expect(
      embedInBatches(["a", "b"], { provider: "openai", batchSize: 1, dimensions: DIMENSIONS, callBatch, sleep })
    ).rejects.toBeInstanceOf(AIProviderError);
  });

  // Regression test for the missing-dimension-check bug: the vector COUNT
  // matches the input count, but an individual vector is the wrong length
  // (e.g. a misconfigured `dimensions`/`output_dimension` request param) --
  // this must be caught here, with a clear, provider-attributed error,
  // rather than surfacing many layers away as a raw pgvector insert failure.
  it("throws a provider-attributed AIProviderError when a returned vector has the wrong dimensions", async () => {
    // batchSize 1 -- a single input/output pair, no bisection involved --
    // isolates this test to exactly the dimension-check branch.
    const callBatch = vi.fn().mockResolvedValue([[1, 2]]); // length 2, expected 3
    const err = await embedInBatches(["only-one"], {
      provider: "openai",
      batchSize: 1,
      dimensions: DIMENSIONS,
      callBatch,
      sleep,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AIProviderError);
    expect((err as AIProviderError).message).toContain("openai");
    expect((err as AIProviderError).message).toContain("expected 3");
  });
});
