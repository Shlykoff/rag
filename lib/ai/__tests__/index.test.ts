// lib/ai/__tests__/index.test.ts
//
// getAIProviders()/getEmbeddingsProvider() build adapters from the
// project's two catalog rows (provider, model id, dimensions) and its
// owner's keys. Catalog and key lookups are mocked; the adapters are real.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { aiModel, FIXTURE_CATALOG, fixtureModel } from "../../testing/ai-model-fixtures";
import type { AIModel } from "../catalog";

const RETIRED_CHAT = aiModel({ provider: "openai", modelId: "gpt-retired", kind: "chat", isActive: false });
const MODELS: AIModel[] = [...FIXTURE_CATALOG, RETIRED_CHAT];

const mockGetAIProviderCredential = vi.fn();
const mockGetAIModel = vi.fn(async (_supabase: unknown, id: string) => MODELS.find((m) => m.id === id) ?? null);

vi.mock("../credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../credentials")>();
  return { ...actual, getAIProviderCredential: (...args: unknown[]) => mockGetAIProviderCredential(...args) };
});

vi.mock("../catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../catalog")>();
  return { ...actual, getAIModel: (supabase: unknown, id: string) => mockGetAIModel(supabase, id) };
});

import { getAIProviders, getEmbeddingsProvider, getProviderLabel, type ProjectAIConfigRow } from "../index";
import { AIProviderError } from "../errors";

const PROJECT_ID = "project-1";
const OWNER_ID = "owner-1";

function projectRow(chatModelId: string | null, embeddingModelId: string | null, userId = OWNER_ID): ProjectAIConfigRow {
  return { id: PROJECT_ID, user_id: userId, chat_model_id: chatModelId, embedding_model_id: embeddingModelId };
}

function projectWith(chat: string | null, embedding: string | null, userId = OWNER_ID): ProjectAIConfigRow {
  return projectRow(chat === null ? null : fixtureModel(chat).id, embedding === null ? null : fixtureModel(embedding).id, userId);
}

/** Only `.from("projects")` is queried directly; catalog and keys are mocked above. */
function fakeSupabase(project: ProjectAIConfigRow | null): SupabaseClient {
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
  } as unknown as SupabaseClient;
}

const noQueries = {
  from() {
    throw new Error("must not query projects when preFetchedProjectRow is given");
  },
} as unknown as SupabaseClient;

function withKeys(keys: Partial<Record<string, string>>) {
  mockGetAIProviderCredential.mockImplementation(
    async (_supabase: unknown, _ownerUserId: string, provider: string) => keys[provider] ?? null
  );
}

async function expectNoCredentials(promise: Promise<unknown>): Promise<AIProviderError> {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AIProviderError);
  expect((err as AIProviderError).kind).toBe("no_credentials");
  expect((err as AIProviderError).retryable).toBe(false);
  return err as AIProviderError;
}

const params = { projectId: PROJECT_ID, ownerUserId: OWNER_ID };

afterEach(() => vi.clearAllMocks());

describe("getAIProviders", () => {
  it("throws a plain Error when the project doesn't belong to ownerUserId, before any lookup", async () => {
    await expect(
      getAIProviders(params, fakeSupabase(projectWith("gpt-5.6-luna", "text-embedding-3-small", "someone-else")))
    ).rejects.toThrow(/does not exist or does not belong to user/);
    expect(mockGetAIModel).not.toHaveBeenCalled();
    expect(mockGetAIProviderCredential).not.toHaveBeenCalled();
  });

  it("no chat model chosen -> no_credentials asking to choose one, without any catalog or key lookup", async () => {
    const err = await expectNoCredentials(getAIProviders(params, fakeSupabase(projectWith(null, "text-embedding-3-small"))));
    expect(err.userMessage).toMatch(/Выберите модель чата в настройках проекта/);
    expect(mockGetAIModel).not.toHaveBeenCalled();
    expect(mockGetAIProviderCredential).not.toHaveBeenCalled();
  });

  it("no embedding model chosen -> no_credentials asking to choose one", async () => {
    withKeys({ openai: "k" });
    const err = await expectNoCredentials(getAIProviders(params, fakeSupabase(projectWith("gpt-5.6-luna", null))));
    expect(err.userMessage).toMatch(/Выберите модель эмбеддингов в настройках проекта/);
  });

  it("missing key for the chat model's provider -> no_credentials", async () => {
    withKeys({});
    const err = await expectNoCredentials(
      getAIProviders(params, fakeSupabase(projectWith("gpt-5.6-luna", "text-embedding-3-small")))
    );
    expect(err.userMessage).toMatch(/OpenAI/);
    expect(mockGetAIProviderCredential).toHaveBeenCalledWith(expect.anything(), OWNER_ID, "openai");
  });

  it("missing key for the embedding model's provider -> no_credentials", async () => {
    withKeys({ anthropic: "k" });
    await expectNoCredentials(getAIProviders(params, fakeSupabase(projectWith("claude-opus-5", "voyage-4-large"))));
    expect(mockGetAIProviderCredential).toHaveBeenCalledWith(expect.anything(), OWNER_ID, "voyage");
  });

  it("openai chat + openai embeddings: model ids and dimension come from the catalog rows", async () => {
    withKeys({ openai: "k" });

    const { chatProvider, embeddingsProvider } = await getAIProviders(
      params,
      fakeSupabase(projectWith("gpt-4.1-mini", "text-embedding-3-small"))
    );

    expect(chatProvider).toMatchObject({ providerName: "openai", modelName: "gpt-4.1-mini" });
    expect(embeddingsProvider).toMatchObject({ providerName: "openai", modelName: "text-embedding-3-small", dimensions: 1536 });
  });

  it("gemini chat + gemini embeddings at 3072 dimensions", async () => {
    withKeys({ gemini: "k" });

    const { chatProvider, embeddingsProvider } = await getAIProviders(
      params,
      fakeSupabase(projectWith("gemini-3.8-flash", "gemini-embedding-001"))
    );

    expect(chatProvider).toMatchObject({ providerName: "gemini", modelName: "gemini-3.8-flash" });
    expect(embeddingsProvider).toMatchObject({ providerName: "gemini", modelName: "gemini-embedding-001", dimensions: 3072 });
  });

  it("anthropic chat + voyage embeddings at 1024 dimensions", async () => {
    withKeys({ anthropic: "k", voyage: "v" });

    const { chatProvider, embeddingsProvider } = await getAIProviders(
      params,
      fakeSupabase(projectWith("claude-opus-5", "voyage-4-large"))
    );

    expect(chatProvider).toMatchObject({ providerName: "anthropic", modelName: "claude-opus-5" });
    expect(embeddingsProvider).toMatchObject({ providerName: "voyage", modelName: "voyage-4-large", dimensions: 1024 });
  });

  it("anthropic chat pairs with any embedding provider -- here Gemini, no Voyage key needed", async () => {
    withKeys({ anthropic: "k", gemini: "g" });

    const { embeddingsProvider } = await getAIProviders(params, fakeSupabase(projectWith("claude-opus-5", "gemini-embedding-001")));

    expect(embeddingsProvider.providerName).toBe("gemini");
    expect(mockGetAIProviderCredential).not.toHaveBeenCalledWith(expect.anything(), OWNER_ID, "voyage");
  });

  it("a retired model that is still selected keeps working", async () => {
    withKeys({ openai: "k" });
    const project = projectRow(RETIRED_CHAT.id, fixtureModel("text-embedding-3-small").id);

    const { chatProvider } = await getAIProviders(params, fakeSupabase(project));

    expect(chatProvider.modelName).toBe("gpt-retired");
  });

  it("a model id missing from the catalog is a plain Error, not no_credentials", async () => {
    withKeys({ openai: "k" });
    const project = projectRow("99999999-9999-4999-8999-999999999999", fixtureModel("text-embedding-3-small").id);

    const err = await getAIProviders(params, fakeSupabase(project)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AIProviderError);
  });

  it("uses preFetchedProjectRow without querying projects, still enforcing ownership", async () => {
    withKeys({ openai: "k" });

    const { chatProvider } = await getAIProviders(
      { ...params, preFetchedProjectRow: projectWith("gpt-5.6-luna", "text-embedding-3-small") },
      noQueries
    );
    expect(chatProvider.modelName).toBe("gpt-5.6-luna");

    await expect(
      getAIProviders(
        { ...params, preFetchedProjectRow: projectWith("gpt-5.6-luna", "text-embedding-3-small", "someone-else") },
        noQueries
      )
    ).rejects.toThrow(/does not belong to user/);
  });
});

describe("getEmbeddingsProvider", () => {
  it("needs only the embedding model -- works with no chat model chosen", async () => {
    withKeys({ voyage: "v" });

    const embeddingsProvider = await getEmbeddingsProvider(params, fakeSupabase(projectWith(null, "voyage-4-large")));

    expect(embeddingsProvider).toMatchObject({ providerName: "voyage", modelName: "voyage-4-large", dimensions: 1024 });
  });

  it("throws no_credentials when no embedding model is chosen", async () => {
    await expectNoCredentials(getEmbeddingsProvider(params, fakeSupabase(projectWith("gpt-5.6-luna", null))));
  });
});

describe("getProviderLabel", () => {
  it("labels every credential provider and nothing else", () => {
    expect(getProviderLabel("gemini")).toBe("Google Gemini");
    expect(getProviderLabel("voyage")).toBe("Voyage AI");
    expect(getProviderLabel("not-a-provider")).toBeUndefined();
  });
});
