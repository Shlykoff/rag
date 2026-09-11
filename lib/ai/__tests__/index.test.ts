// lib/ai/__tests__/index.test.ts
//
// getAIProviders()/getEmbeddingsProvider() build providers from a project's
// two settings (chat model + embedding model) and its owner's keys. The
// DB-backed credential lookup is mocked; the provider adapters are real, so
// the chat/embeddings modelName separation is exercised for real.

import { afterEach, describe, expect, it, vi } from "vitest";

const mockGetActiveProvider = vi.fn();
const mockGetAIProviderCredential = vi.fn();

vi.mock("../credentials", () => ({
  getActiveProvider: (...args: unknown[]) => mockGetActiveProvider(...args),
  getAIProviderCredential: (...args: unknown[]) => mockGetAIProviderCredential(...args),
}));

import { getAIProviders, getEmbeddingsProvider, getActiveProviderLabel, type ProjectAIConfigRow } from "../index";
import { AIProviderError } from "../errors";
import type { SupabaseClient } from "@supabase/supabase-js";

const PROJECT_ID = "project-1";
const OWNER_ID = "owner-1";

function projectRow(overrides: Partial<ProjectAIConfigRow> = {}): ProjectAIConfigRow {
  return { id: PROJECT_ID, user_id: OWNER_ID, active_ai_provider: "openai", embedding_provider: "openai", ...overrides };
}

/** Only `.from("projects")` is queried by getAIProviders() itself; credentials are mocked above. */
function fakeSupabase(project: ProjectAIConfigRow | null) {
  return {
    from(table: string) {
      if (table !== "projects") throw new Error(`fakeSupabase: unexpected table ${table}`);
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        maybeSingle: async () => ({ data: project, error: null }),
      };
    },
  } as never;
}

function withKeys(keys: Partial<Record<string, string>>) {
  mockGetAIProviderCredential.mockImplementation(
    async (_supabase: unknown, _ownerUserId: string, provider: string) => keys[provider] ?? null
  );
}

async function expectNoCredentials(promise: Promise<unknown>) {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AIProviderError);
  expect((err as AIProviderError).kind).toBe("no_credentials");
  expect((err as AIProviderError).retryable).toBe(false);
}

const ENV_KEYS = ["OPENAI_CHAT_MODEL", "OPENAI_EMBEDDING_MODEL", "GEMINI_CHAT_MODEL", "GEMINI_EMBEDDING_MODEL"] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function clearModelEnv() {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}

function restoreModelEnv() {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("getAIProviders({projectId, ownerUserId}, supabase)", () => {
  afterEach(() => {
    restoreModelEnv();
    vi.clearAllMocks();
  });

  it("throws a plain Error when the project doesn't belong to ownerUserId, before touching any credential", async () => {
    clearModelEnv();
    const supabase = fakeSupabase(projectRow({ user_id: "someone-else" }));

    await expect(getAIProviders({ projectId: PROJECT_ID, ownerUserId: OWNER_ID }, supabase)).rejects.toThrow(
      /does not exist or does not belong to user/
    );
    expect(mockGetAIProviderCredential).not.toHaveBeenCalled();
  });

  it("throws no_credentials when the project has no chat model chosen, without loading any key", async () => {
    clearModelEnv();
    await expectNoCredentials(
      getAIProviders({ projectId: PROJECT_ID, ownerUserId: OWNER_ID }, fakeSupabase(projectRow({ active_ai_provider: null })))
    );
    expect(mockGetAIProviderCredential).not.toHaveBeenCalled();
  });

  it("throws no_credentials when the project has no embedding model chosen", async () => {
    clearModelEnv();
    withKeys({ openai: "test-openai-key" });
    await expectNoCredentials(
      getAIProviders({ projectId: PROJECT_ID, ownerUserId: OWNER_ID }, fakeSupabase(projectRow({ embedding_provider: null })))
    );
  });

  it("throws no_credentials when the chat provider's key is missing", async () => {
    clearModelEnv();
    withKeys({});
    await expectNoCredentials(getAIProviders({ projectId: PROJECT_ID, ownerUserId: OWNER_ID }, fakeSupabase(projectRow())));
    expect(mockGetAIProviderCredential).toHaveBeenCalledWith(expect.anything(), OWNER_ID, "openai");
  });

  it("throws no_credentials when the embedding provider's key is missing", async () => {
    clearModelEnv();
    withKeys({ anthropic: "test-anthropic-key" });
    await expectNoCredentials(
      getAIProviders(
        { projectId: PROJECT_ID, ownerUserId: OWNER_ID },
        fakeSupabase(projectRow({ active_ai_provider: "anthropic", embedding_provider: "voyage" }))
      )
    );
  });

  // Guards the two-distinct-views design in providers/openai.ts: a single
  // dual-interface object would let `embeddingsProvider.modelName` silently
  // return the chat model, which ingestion writes into
  // document_chunks.embedding_model.
  it("openai + openai: distinct objects with distinct, correct model names", async () => {
    clearModelEnv();
    withKeys({ openai: "test-openai-key" });

    const { chatProvider, embeddingsProvider } = await getAIProviders(
      { projectId: PROJECT_ID, ownerUserId: OWNER_ID },
      fakeSupabase(projectRow())
    );

    expect(chatProvider).not.toBe(embeddingsProvider);
    expect(chatProvider.modelName).toBe("gpt-4.1-mini");
    expect(embeddingsProvider.modelName).toBe("text-embedding-3-small");
    expect(chatProvider.providerName).toBe("openai");
    expect(embeddingsProvider.providerName).toBe("openai");
  });

  it("gemini + gemini: distinct objects with distinct, correct model names", async () => {
    clearModelEnv();
    withKeys({ gemini: "test-gemini-key" });

    const { chatProvider, embeddingsProvider } = await getAIProviders(
      { projectId: PROJECT_ID, ownerUserId: OWNER_ID },
      fakeSupabase(projectRow({ active_ai_provider: "gemini", embedding_provider: "gemini" }))
    );

    expect(chatProvider.modelName).toBe("gemini-3.6-flash");
    expect(embeddingsProvider.modelName).toBe("gemini-embedding-001");
    expect(chatProvider.providerName).toBe("gemini");
    expect(embeddingsProvider.providerName).toBe("gemini");
  });

  it("anthropic chat pairs with any embedding provider -- here Gemini, no Voyage key needed", async () => {
    clearModelEnv();
    withKeys({ anthropic: "test-anthropic-key", gemini: "test-gemini-key" });

    const { chatProvider, embeddingsProvider } = await getAIProviders(
      { projectId: PROJECT_ID, ownerUserId: OWNER_ID },
      fakeSupabase(projectRow({ active_ai_provider: "anthropic", embedding_provider: "gemini" }))
    );

    expect(chatProvider.providerName).toBe("anthropic");
    expect(embeddingsProvider.providerName).toBe("gemini");
    expect(mockGetAIProviderCredential).not.toHaveBeenCalledWith(expect.anything(), OWNER_ID, "voyage");
  });

  it("anthropic chat + voyage embeddings", async () => {
    clearModelEnv();
    withKeys({ anthropic: "test-anthropic-key", voyage: "test-voyage-key" });

    const { chatProvider, embeddingsProvider } = await getAIProviders(
      { projectId: PROJECT_ID, ownerUserId: OWNER_ID },
      fakeSupabase(projectRow({ active_ai_provider: "anthropic", embedding_provider: "voyage" }))
    );

    expect(chatProvider.providerName).toBe("anthropic");
    expect(embeddingsProvider.providerName).toBe("voyage");
  });

  it("skips its own projects fetch when preFetchedProjectRow is given, but still enforces the ownership guard", async () => {
    clearModelEnv();
    withKeys({ openai: "test-openai-key" });
    const supabaseThatMustNotBeQueried = {
      from() {
        throw new Error("getAIProviders must not re-fetch the projects row when preFetchedProjectRow is given");
      },
    } as unknown as SupabaseClient;

    const { chatProvider } = await getAIProviders(
      { projectId: PROJECT_ID, ownerUserId: OWNER_ID, preFetchedProjectRow: projectRow() },
      supabaseThatMustNotBeQueried
    );
    expect(chatProvider.providerName).toBe("openai");
  });

  it("still rejects a preFetchedProjectRow whose user_id doesn't match ownerUserId", async () => {
    clearModelEnv();
    const supabaseThatMustNotBeQueried = {
      from() {
        throw new Error("must not be queried");
      },
    } as unknown as SupabaseClient;

    await expect(
      getAIProviders(
        { projectId: PROJECT_ID, ownerUserId: OWNER_ID, preFetchedProjectRow: projectRow({ user_id: "someone-else" }) },
        supabaseThatMustNotBeQueried
      )
    ).rejects.toThrow(/does not exist or does not belong to user/);
    expect(mockGetAIProviderCredential).not.toHaveBeenCalled();
  });

  it("an overridden OPENAI_EMBEDDING_MODEL shows up on embeddingsProvider, not chatProvider", async () => {
    clearModelEnv();
    process.env.OPENAI_CHAT_MODEL = "gpt-4.1-mini";
    process.env.OPENAI_EMBEDDING_MODEL = "text-embedding-3-large";
    withKeys({ openai: "test-openai-key" });

    const { chatProvider, embeddingsProvider } = await getAIProviders(
      { projectId: PROJECT_ID, ownerUserId: OWNER_ID },
      fakeSupabase(projectRow())
    );

    expect(chatProvider.modelName).toBe("gpt-4.1-mini");
    expect(embeddingsProvider.modelName).toBe("text-embedding-3-large");
  });
});

describe("getEmbeddingsProvider({projectId, ownerUserId}, supabase)", () => {
  afterEach(() => {
    restoreModelEnv();
    vi.clearAllMocks();
  });

  it("needs only the embedding model -- works for a project with no chat model chosen yet", async () => {
    clearModelEnv();
    withKeys({ gemini: "test-gemini-key" });

    const embeddingsProvider = await getEmbeddingsProvider(
      { projectId: PROJECT_ID, ownerUserId: OWNER_ID },
      fakeSupabase(projectRow({ active_ai_provider: null, embedding_provider: "gemini" }))
    );

    expect(embeddingsProvider.providerName).toBe("gemini");
    expect(embeddingsProvider.modelName).toBe("gemini-embedding-001");
  });

  it("throws no_credentials when no embedding model is chosen", async () => {
    clearModelEnv();
    await expectNoCredentials(
      getEmbeddingsProvider({ projectId: PROJECT_ID, ownerUserId: OWNER_ID }, fakeSupabase(projectRow({ embedding_provider: null })))
    );
  });
});

describe("getActiveProviderLabel(projectId, supabase)", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns null (never throws) when the project has no chat provider", async () => {
    mockGetActiveProvider.mockResolvedValue(null);
    expect(await getActiveProviderLabel(PROJECT_ID, fakeSupabase(projectRow()))).toBeNull();
  });

  it("returns the registry's display label for the project's chat provider", async () => {
    mockGetActiveProvider.mockResolvedValue("gemini");
    expect(await getActiveProviderLabel(PROJECT_ID, fakeSupabase(projectRow()))).toBe("Google Gemini");
  });
});
