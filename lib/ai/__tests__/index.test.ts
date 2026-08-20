// lib/ai/__tests__/index.test.ts
//
// getAIProviders(userId, supabase) is now per-user, bring-your-own-key
// (async, reads ai_provider_credentials/user_settings via
// lib/ai/credentials.ts instead of a process-global AI_PROVIDER env var).
// This file mocks lib/ai/credentials.ts's DB-backed functions (the same
// "mock the one module-level dependency, exercise this file's own control
// flow" pattern as lib/ingestion/__tests__/ingest-default-providers.test.ts)
// so these tests never need a real Supabase client, while still exercising
// the REAL provider adapters from lib/ai/providers/ -- so this is still the
// regression test for the chat/embeddings modelName-separation bug (see the
// long comment below), just no longer driven by env vars.

import { afterEach, describe, expect, it, vi } from "vitest";

const mockGetActiveProvider = vi.fn();
const mockGetAIProviderCredential = vi.fn();

// Every OTHER named export lib/ai/credentials.ts has is re-exported
// verbatim by lib/ai/index.ts (see that file's bottom) -- stubbed here too
// so importing "../index" doesn't pull in the real DB-backed module (which
// would need a real Supabase client) even for exports this file's own
// tests never call directly.
vi.mock("../credentials", () => ({
  getActiveProvider: (...args: unknown[]) => mockGetActiveProvider(...args),
  getAIProviderCredential: (...args: unknown[]) => mockGetAIProviderCredential(...args),
  saveAIProviderCredential: vi.fn(),
  hasAIProviderCredential: vi.fn(),
  deleteAIProviderCredential: vi.fn(),
  setActiveProvider: vi.fn(),
  MissingProviderCredentialsError: class MissingProviderCredentialsError extends Error {},
}));

import { getAIProviders, getEmbeddingsProvider, getActiveProviderLabel } from "../index";
import { AIProviderError } from "../errors";

const FAKE_SUPABASE = {} as never; // never touched -- getAIProviderCredential/getActiveProvider are mocked above

const ENV_KEYS = [
  "OPENAI_CHAT_MODEL",
  "OPENAI_EMBEDDING_MODEL",
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

describe("getAIProviders(userId, supabase)", () => {
  let saved: SavedEnv;

  afterEach(() => {
    restoreEnv(saved);
    vi.clearAllMocks();
  });

  it("throws AIProviderError{kind:'no_credentials'} when the user has no active_ai_provider set", async () => {
    saved = saveEnv();
    mockGetActiveProvider.mockResolvedValue(null);

    const err = await getAIProviders("user-1", FAKE_SUPABASE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AIProviderError);
    expect((err as AIProviderError).kind).toBe("no_credentials");
    expect((err as AIProviderError).retryable).toBe(false);
    expect((err as AIProviderError).status).toBeUndefined();
    // getAIProviderCredential must never even be reached once there's no
    // active provider to build.
    expect(mockGetAIProviderCredential).not.toHaveBeenCalled();
  });

  it("active provider 'openai' but its credential row is missing -- also 'no_credentials', not a bare/crashing error", async () => {
    saved = saveEnv();
    mockGetActiveProvider.mockResolvedValue("openai");
    mockGetAIProviderCredential.mockResolvedValue(null);

    const err = await getAIProviders("user-1", FAKE_SUPABASE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AIProviderError);
    expect((err as AIProviderError).kind).toBe("no_credentials");
    expect(mockGetAIProviderCredential).toHaveBeenCalledWith(FAKE_SUPABASE, "user-1", "openai");
  });

  // Regression test for a bug reproduced live before this file's env-var
  // days: lib/ai/index.ts used to return the SAME object as both
  // `chatProvider` and `embeddingsProvider` for openai/gemini (both backed
  // by OpenAICompatibleProvider, which only had one `modelName` field wired
  // to the CHAT model). That made `embeddingsProvider.modelName` silently
  // return the chat model, and lib/ingestion/ingest.ts writes exactly that
  // value into document_chunks.embedding_model. Still asserted directly
  // against the real registry/adapters (no mocking of
  // createOpenAICompatiblePair/createGeminiProvider) so it would fail again
  // if the bug were reintroduced.
  it("AI_PROVIDER-equivalent 'openai': chatProvider and embeddingsProvider are distinct objects with distinct, correct modelNames", async () => {
    saved = saveEnv();
    delete process.env.OPENAI_CHAT_MODEL; // exercise the documented default
    delete process.env.OPENAI_EMBEDDING_MODEL; // exercise the documented default
    mockGetActiveProvider.mockResolvedValue("openai");
    mockGetAIProviderCredential.mockResolvedValue("test-openai-key");

    const { chatProvider, embeddingsProvider } = await getAIProviders("user-1", FAKE_SUPABASE);

    expect(chatProvider).not.toBe(embeddingsProvider);
    expect(chatProvider.modelName).toBe("gpt-4.1-mini");
    expect(embeddingsProvider.modelName).toBe("text-embedding-3-small");
    expect(chatProvider.providerName).toBe("openai");
    expect(embeddingsProvider.providerName).toBe("openai");
    expect(mockGetAIProviderCredential).toHaveBeenCalledWith(FAKE_SUPABASE, "user-1", "openai");
  });

  it("'gemini': chatProvider and embeddingsProvider are distinct objects with distinct, correct modelNames", async () => {
    saved = saveEnv();
    delete process.env.GEMINI_CHAT_MODEL;
    delete process.env.GEMINI_EMBEDDING_MODEL;
    mockGetActiveProvider.mockResolvedValue("gemini");
    mockGetAIProviderCredential.mockResolvedValue("test-gemini-key");

    const { chatProvider, embeddingsProvider } = await getAIProviders("user-1", FAKE_SUPABASE);

    expect(chatProvider).not.toBe(embeddingsProvider);
    expect(chatProvider.modelName).toBe("gemini-3.6-flash");
    expect(embeddingsProvider.modelName).toBe("gemini-embedding-001");
    expect(chatProvider.providerName).toBe("gemini");
    expect(embeddingsProvider.providerName).toBe("gemini");
  });

  it("'anthropic': fetches BOTH the anthropic and voyage credentials and pairs AnthropicChatProvider with VoyageEmbeddingsProvider", async () => {
    saved = saveEnv();
    mockGetActiveProvider.mockResolvedValue("anthropic");
    mockGetAIProviderCredential.mockImplementation(
      async (_supabase: unknown, _userId: string, provider: string) =>
        provider === "anthropic" ? "test-anthropic-key" : provider === "voyage" ? "test-voyage-key" : null
    );

    const { chatProvider, embeddingsProvider } = await getAIProviders("user-1", FAKE_SUPABASE);

    expect(chatProvider.providerName).toBe("anthropic");
    expect(embeddingsProvider.providerName).toBe("voyage");
    expect(mockGetAIProviderCredential).toHaveBeenCalledWith(FAKE_SUPABASE, "user-1", "anthropic");
    expect(mockGetAIProviderCredential).toHaveBeenCalledWith(FAKE_SUPABASE, "user-1", "voyage");
  });

  it("'anthropic': the anthropic credential exists but voyage doesn't -- still 'no_credentials' (fetched independently of setActiveProvider's own prior check)", async () => {
    saved = saveEnv();
    mockGetActiveProvider.mockResolvedValue("anthropic");
    mockGetAIProviderCredential.mockImplementation(
      async (_supabase: unknown, _userId: string, provider: string) => (provider === "anthropic" ? "test-anthropic-key" : null)
    );

    const err = await getAIProviders("user-1", FAKE_SUPABASE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AIProviderError);
    expect((err as AIProviderError).kind).toBe("no_credentials");
  });

  it("an overridden OPENAI_EMBEDDING_MODEL shows up on embeddingsProvider, not chatProvider", async () => {
    saved = saveEnv();
    process.env.OPENAI_CHAT_MODEL = "gpt-4.1-mini";
    process.env.OPENAI_EMBEDDING_MODEL = "text-embedding-3-large";
    mockGetActiveProvider.mockResolvedValue("openai");
    mockGetAIProviderCredential.mockResolvedValue("test-openai-key");

    const { chatProvider, embeddingsProvider } = await getAIProviders("user-1", FAKE_SUPABASE);

    expect(chatProvider.modelName).toBe("gpt-4.1-mini");
    expect(embeddingsProvider.modelName).toBe("text-embedding-3-large");
  });
});

describe("getEmbeddingsProvider(userId, supabase)", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns just the embeddingsProvider half of getAIProviders()'s pair", async () => {
    mockGetActiveProvider.mockResolvedValue("gemini");
    mockGetAIProviderCredential.mockResolvedValue("test-gemini-key");

    const embeddingsProvider = await getEmbeddingsProvider("user-1", FAKE_SUPABASE);
    expect(embeddingsProvider.providerName).toBe("gemini");
    expect(embeddingsProvider.modelName).toBe("gemini-embedding-001");
  });

  it("propagates the 'no_credentials' failure the same way getAIProviders() does", async () => {
    mockGetActiveProvider.mockResolvedValue(null);
    await expect(getEmbeddingsProvider("user-1", FAKE_SUPABASE)).rejects.toMatchObject({ kind: "no_credentials" });
  });
});

describe("getActiveProviderLabel(userId, supabase)", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns null (never throws) when the user has no active provider", async () => {
    mockGetActiveProvider.mockResolvedValue(null);
    expect(await getActiveProviderLabel("user-1", FAKE_SUPABASE)).toBeNull();
  });

  it("returns the registry's display label for the user's active provider", async () => {
    mockGetActiveProvider.mockResolvedValue("gemini");
    expect(await getActiveProviderLabel("user-1", FAKE_SUPABASE)).toBe("Google Gemini");
  });
});
