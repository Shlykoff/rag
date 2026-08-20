// lib/ai/__tests__/index.test.ts
//
// Regression test for a bug reproduced live: for AI_PROVIDER=openai and
// AI_PROVIDER=gemini, lib/ai/index.ts used to return the SAME object as
// both `chatProvider` and `embeddingsProvider` (both backed by
// OpenAICompatibleProvider, which only had one `modelName` field wired to
// the CHAT model). That made `embeddingsProvider.modelName` silently
// return the chat model, and lib/ingestion/ingest.ts writes exactly that
// value into document_chunks.embedding_model -- so a real
// AI_PROVIDER=gemini ingest through a real Google Drive document recorded
// embedding_model = "gemini-3.6-flash" (the configured CHAT model) instead
// of "gemini-embedding-001" (the configured embedding model). The actual
// embed() HTTP calls always used the correct model -- only this piece of
// metadata was wrong.
//
// This test asserts the fixed contract directly against the real registry
// (no mocking of the provider adapters) so it would have failed against
// the pre-fix code and fails again if the bug is reintroduced.

import { afterEach, describe, expect, it } from "vitest";
import {
  __resetAIProviderCacheForTests,
  getAIProviders,
} from "../index";

const ENV_KEYS = [
  "AI_PROVIDER",
  "OPENAI_API_KEY",
  "OPENAI_CHAT_MODEL",
  "OPENAI_EMBEDDING_MODEL",
  "GEMINI_API_KEY",
  "GEMINI_CHAT_MODEL",
  "GEMINI_EMBEDDING_MODEL",
] as const;

type SavedEnv = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

function saveEnv(): SavedEnv {
  const saved: SavedEnv = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved: SavedEnv): void {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("getAIProviders() -- chat/embeddings model separation", () => {
  let saved: SavedEnv;

  afterEach(() => {
    restoreEnv(saved);
    __resetAIProviderCacheForTests();
  });

  it("AI_PROVIDER=openai: chatProvider and embeddingsProvider are distinct objects with distinct, correct modelNames", () => {
    saved = saveEnv();
    __resetAIProviderCacheForTests();
    process.env.AI_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-openai-key";
    delete process.env.OPENAI_CHAT_MODEL; // exercise the documented default
    delete process.env.OPENAI_EMBEDDING_MODEL; // exercise the documented default

    const { chatProvider, embeddingsProvider } = getAIProviders();

    // Not the same object handed out twice -- see module comment. Referential
    // equality here is exactly the shape of the original bug (one object,
    // one modelName, silently reused for both roles).
    expect(chatProvider).not.toBe(embeddingsProvider);

    expect(chatProvider.modelName).toBe("gpt-4.1-mini");
    expect(embeddingsProvider.modelName).toBe("text-embedding-3-small");
    expect(chatProvider.modelName).not.toBe(embeddingsProvider.modelName);

    // providerName is legitimately shared (both are 'openai') -- only
    // modelName was ever the bug.
    expect(chatProvider.providerName).toBe("openai");
    expect(embeddingsProvider.providerName).toBe("openai");
  });

  it("AI_PROVIDER=gemini: chatProvider and embeddingsProvider are distinct objects with distinct, correct modelNames", () => {
    saved = saveEnv();
    __resetAIProviderCacheForTests();
    process.env.AI_PROVIDER = "gemini";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    delete process.env.GEMINI_CHAT_MODEL; // exercise the documented default
    delete process.env.GEMINI_EMBEDDING_MODEL; // exercise the documented default

    const { chatProvider, embeddingsProvider } = getAIProviders();

    expect(chatProvider).not.toBe(embeddingsProvider);

    // This is the exact pair reproduced live against a real Google Drive
    // document: before the fix, embeddingsProvider.modelName was
    // "gemini-3.6-flash" (the chat model) instead of
    // "gemini-embedding-001".
    expect(chatProvider.modelName).toBe("gemini-3.6-flash");
    expect(embeddingsProvider.modelName).toBe("gemini-embedding-001");
    expect(chatProvider.modelName).not.toBe(embeddingsProvider.modelName);

    expect(chatProvider.providerName).toBe("gemini");
    expect(embeddingsProvider.providerName).toBe("gemini");
  });

  it("AI_PROVIDER=openai: an overridden OPENAI_EMBEDDING_MODEL shows up on embeddingsProvider, not chatProvider", () => {
    saved = saveEnv();
    __resetAIProviderCacheForTests();
    process.env.AI_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.OPENAI_CHAT_MODEL = "gpt-4.1-mini";
    process.env.OPENAI_EMBEDDING_MODEL = "text-embedding-3-large";

    const { chatProvider, embeddingsProvider } = getAIProviders();

    expect(chatProvider.modelName).toBe("gpt-4.1-mini");
    expect(embeddingsProvider.modelName).toBe("text-embedding-3-large");
  });
});
