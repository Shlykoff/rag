// lib/ai/__tests__/providers.test.ts
//
// The embeddings adapters request the catalog dimension from the vendor and
// reject vectors of any other length. The vendor SDKs are replaced with
// recording fakes; no network.

import { afterEach, describe, expect, it, vi } from "vitest";

interface EmbeddingsRequest {
  model: string;
  input: string[];
  dimensions?: number;
  outputDimension?: number;
}

const sdk = vi.hoisted(() => ({
  openAIConfigs: [] as Array<Record<string, unknown>>,
  openAIRequests: [] as EmbeddingsRequest[],
  voyageRequests: [] as EmbeddingsRequest[],
  /** Forces the fake vendor to return vectors of this length instead of the requested one. */
  returnedLength: null as number | null,
}));

vi.mock("openai", () => ({
  default: class FakeOpenAI {
    embeddings = {
      create: async (request: EmbeddingsRequest) => {
        sdk.openAIRequests.push(request);
        const length = sdk.returnedLength ?? request.dimensions ?? 0;
        return { data: request.input.map((_, index) => ({ index, embedding: new Array(length).fill(0.5) })) };
      },
    };
    constructor(config: Record<string, unknown>) {
      sdk.openAIConfigs.push(config);
    }
  },
}));

vi.mock("voyageai", () => ({
  VoyageAIClient: class FakeVoyage {
    async embed(request: EmbeddingsRequest) {
      sdk.voyageRequests.push(request);
      const length = sdk.returnedLength ?? request.outputDimension ?? 0;
      return { data: request.input.map((_, index) => ({ index, embedding: new Array(length).fill(0.5) })) };
    }
  },
}));

import { OpenAICompatibleChatProvider, OpenAICompatibleEmbeddingsProvider } from "../providers/openai";
import {
  createGeminiChatProvider,
  createGeminiEmbeddingsProvider,
  GEMINI_OPENAI_COMPATIBLE_BASE_URL,
} from "../providers/gemini";
import { VoyageEmbeddingsProvider } from "../providers/voyage";
import { AIProviderError } from "../errors";

afterEach(() => {
  sdk.openAIConfigs.length = 0;
  sdk.openAIRequests.length = 0;
  sdk.voyageRequests.length = 0;
  sdk.returnedLength = null;
});

describe("OpenAI embeddings adapter", () => {
  it("requests the configured dimension and returns vectors of that length", async () => {
    const provider = new OpenAICompatibleEmbeddingsProvider({ apiKey: "k", model: "text-embedding-3-small", dimensions: 1536 });

    const vectors = await provider.embed(["a", "b"]);

    expect(sdk.openAIRequests).toEqual([{ model: "text-embedding-3-small", input: ["a", "b"], dimensions: 1536 }]);
    expect(vectors.map((v) => v.length)).toEqual([1536, 1536]);
    expect(provider).toMatchObject({ providerName: "openai", modelName: "text-embedding-3-small", dimensions: 1536 });
    expect(sdk.openAIConfigs[0]).toMatchObject({ apiKey: "k", baseURL: undefined, maxRetries: 0 });
  });

  it("rejects vectors whose length differs from the requested dimension", async () => {
    sdk.returnedLength = 1024;
    const provider = new OpenAICompatibleEmbeddingsProvider({ apiKey: "k", model: "text-embedding-3-large", dimensions: 3072 });

    const err = await provider.embed(["a"]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AIProviderError);
    expect((err as AIProviderError).message).toMatch(/expected 3072/);
  });
});

describe("Gemini adapters (OpenAI-compatible endpoint)", () => {
  it("embeddings go to Google's base URL with the catalog dimension", async () => {
    const provider = createGeminiEmbeddingsProvider({ apiKey: "g", model: "gemini-embedding-001", dimensions: 3072 });

    const vectors = await provider.embed(["q"]);

    expect(sdk.openAIConfigs[0]).toMatchObject({ apiKey: "g", baseURL: GEMINI_OPENAI_COMPATIBLE_BASE_URL });
    expect(sdk.openAIRequests[0]).toMatchObject({ model: "gemini-embedding-001", dimensions: 3072 });
    expect(vectors[0]).toHaveLength(3072);
    expect(provider).toMatchObject({ providerName: "gemini", modelName: "gemini-embedding-001", dimensions: 3072 });
  });

  it("chat is labeled gemini with the catalog model id", () => {
    expect(createGeminiChatProvider({ apiKey: "g", model: "gemini-3.8-flash" })).toMatchObject({
      providerName: "gemini",
      modelName: "gemini-3.8-flash",
    });
  });
});

describe("OpenAI chat adapter", () => {
  it("carries the catalog model id", () => {
    expect(new OpenAICompatibleChatProvider({ apiKey: "k", model: "gpt-5.6-luna" })).toMatchObject({
      providerName: "openai",
      modelName: "gpt-5.6-luna",
    });
  });
});

describe("Voyage embeddings adapter", () => {
  it("requests the catalog dimension as outputDimension", async () => {
    const provider = new VoyageEmbeddingsProvider({ apiKey: "v", model: "voyage-4-large", dimensions: 1024 });

    const vectors = await provider.embed(["a"]);

    expect(sdk.voyageRequests).toEqual([{ input: ["a"], model: "voyage-4-large", outputDimension: 1024 }]);
    expect(vectors[0]).toHaveLength(1024);
    expect(provider).toMatchObject({ providerName: "voyage", modelName: "voyage-4-large", dimensions: 1024 });
  });

  it("rejects vectors of another length", async () => {
    sdk.returnedLength = 512;
    const provider = new VoyageEmbeddingsProvider({ apiKey: "v", model: "voyage-4", dimensions: 1024 });

    await expect(provider.embed(["a"])).rejects.toBeInstanceOf(AIProviderError);
  });
});
