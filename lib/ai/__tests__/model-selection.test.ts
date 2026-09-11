// lib/ai/__tests__/model-selection.test.ts
//
// Validation when a project's chat/embedding model is set: the catalog row
// must exist, fit the slot and be active; the owner needs that provider's
// key; a chosen embedding model is locked once the project has documents.
// Catalog and key lookups are mocked; projects/documents go through a fake.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { aiModel, FIXTURE_CATALOG, fixtureModel } from "../../testing/ai-model-fixtures";
import type { AIModel } from "../catalog";

const RETIRED_CHAT = aiModel({ provider: "openai", modelId: "gpt-retired", kind: "chat", isActive: false });
const MODELS: AIModel[] = [...FIXTURE_CATALOG, RETIRED_CHAT];

const mockHasAIProviderCredential = vi.fn();

vi.mock("../catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../catalog")>();
  return { ...actual, getAIModel: async (_supabase: unknown, id: string) => MODELS.find((m) => m.id === id) ?? null };
});

vi.mock("../credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../credentials")>();
  return { ...actual, hasAIProviderCredential: (...args: unknown[]) => mockHasAIProviderCredential(...args) };
});

import {
  assertSelectableModel,
  EmbeddingModelLockedError,
  InvalidModelSelectionError,
  MissingProviderCredentialsError,
  setProjectChatModel,
  setProjectEmbeddingModel,
} from "../model-selection";

const PROJECT_ID = "project-1";
const OWNER_ID = "owner-1";

interface FakeProject {
  user_id: string;
  chat_model_id: string | null;
  embedding_model_id: string | null;
}

function fakeSupabase(project: Partial<FakeProject> = {}, documentCount = 0) {
  const row = { id: PROJECT_ID, user_id: OWNER_ID, chat_model_id: null, embedding_model_id: null, ...project };
  const updates: Array<{ values: Record<string, unknown>; id: unknown }> = [];
  const client = {
    from(table: string) {
      if (table === "projects") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
          update: (values: Record<string, unknown>) => ({
            eq: async (_column: string, id: unknown) => {
              updates.push({ values, id });
              return { error: null };
            },
          }),
        };
      }
      if (table === "documents") {
        return { select: () => ({ eq: async () => ({ count: documentCount, error: null }) }) };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
  return { client, updates };
}

function withKeys(...providers: string[]) {
  mockHasAIProviderCredential.mockImplementation(async (_s: unknown, _u: string, provider: string) => providers.includes(provider));
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (err: unknown) => err
  );
}

afterEach(() => vi.clearAllMocks());

describe("assertSelectableModel", () => {
  const luna = fixtureModel("gpt-5.6-luna");

  it.each([
    ["an unknown id", "chat" as const, null, null, "not_found"],
    ["an embedding model in the chat slot", "chat" as const, fixtureModel("voyage-4-large"), null, "wrong_kind"],
    ["a chat model in the embedding slot", "embedding" as const, luna, null, "wrong_kind"],
    ["a retired model that isn't the current one", "chat" as const, RETIRED_CHAT, luna.id, "inactive"],
  ])("rejects %s", (_label, slot, model, current, reason) => {
    try {
      assertSelectableModel(slot, "requested-id", model, current);
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidModelSelectionError);
      expect((err as InvalidModelSelectionError).reason).toBe(reason);
    }
  });

  it("accepts an active model of the right kind, and a retired model that is already selected", () => {
    expect(() => assertSelectableModel("chat", luna.id, luna, null)).not.toThrow();
    expect(() => assertSelectableModel("chat", RETIRED_CHAT.id, RETIRED_CHAT, RETIRED_CHAT.id)).not.toThrow();
  });
});

describe("setProjectChatModel", () => {
  it("sets the model and mirrors its provider into active_ai_provider", async () => {
    withKeys("anthropic");
    const { client, updates } = fakeSupabase();
    const opus = fixtureModel("claude-opus-5");

    await expect(setProjectChatModel(client, PROJECT_ID, OWNER_ID, opus.id)).resolves.toEqual(opus);

    expect(updates).toEqual([{ values: { chat_model_id: opus.id, active_ai_provider: "anthropic" }, id: PROJECT_ID }]);
  });

  it("can switch even when the project has documents", async () => {
    withKeys("openai", "gemini");
    const { client, updates } = fakeSupabase({ chat_model_id: fixtureModel("gpt-5.6-luna").id }, 5);

    await setProjectChatModel(client, PROJECT_ID, OWNER_ID, fixtureModel("gemini-3.8-flash").id);

    expect(updates).toHaveLength(1);
  });

  it("refuses a provider whose key the owner hasn't saved", async () => {
    withKeys();
    const { client, updates } = fakeSupabase();

    const err = await rejection(setProjectChatModel(client, PROJECT_ID, OWNER_ID, fixtureModel("gpt-5.6-luna").id));

    expect(err).toBeInstanceOf(MissingProviderCredentialsError);
    expect((err as MissingProviderCredentialsError).provider).toBe("openai");
    expect(updates).toEqual([]);
  });

  it("rejects an embedding model before checking keys", async () => {
    const { client, updates } = fakeSupabase();

    const err = await rejection(setProjectChatModel(client, PROJECT_ID, OWNER_ID, fixtureModel("voyage-4-large").id));

    expect((err as InvalidModelSelectionError).reason).toBe("wrong_kind");
    expect(mockHasAIProviderCredential).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("rejects a retired model as a new choice", async () => {
    withKeys("openai");
    const { client } = fakeSupabase();
    const err = await rejection(setProjectChatModel(client, PROJECT_ID, OWNER_ID, RETIRED_CHAT.id));
    expect((err as InvalidModelSelectionError).reason).toBe("inactive");
  });

  it("re-selecting the current (even retired) model is a no-op", async () => {
    const { client, updates } = fakeSupabase({ chat_model_id: RETIRED_CHAT.id });

    await setProjectChatModel(client, PROJECT_ID, OWNER_ID, RETIRED_CHAT.id);

    expect(updates).toEqual([]);
    expect(mockHasAIProviderCredential).not.toHaveBeenCalled();
  });

  it("refuses a project owned by someone else", async () => {
    withKeys("openai");
    const { client, updates } = fakeSupabase({ user_id: "someone-else" });

    await expect(setProjectChatModel(client, PROJECT_ID, OWNER_ID, fixtureModel("gpt-5.6-luna").id)).rejects.toThrow(
      /belongs to user/
    );
    expect(updates).toEqual([]);
  });
});

describe("setProjectEmbeddingModel", () => {
  const small = fixtureModel("text-embedding-3-small");
  const gemini = fixtureModel("gemini-embedding-001");

  it("allows the first choice even when the project already has documents, mirroring embedding_provider", async () => {
    withKeys("gemini");
    const { client, updates } = fakeSupabase({}, 3);

    await setProjectEmbeddingModel(client, PROJECT_ID, OWNER_ID, gemini.id);

    expect(updates).toEqual([{ values: { embedding_model_id: gemini.id, embedding_provider: "gemini" }, id: PROJECT_ID }]);
  });

  it("can change while the project has no documents", async () => {
    withKeys("openai", "gemini");
    const { client, updates } = fakeSupabase({ embedding_model_id: small.id }, 0);

    await setProjectEmbeddingModel(client, PROJECT_ID, OWNER_ID, gemini.id);

    expect(updates).toHaveLength(1);
  });

  it("is locked once a chosen model has documents", async () => {
    withKeys("openai", "gemini");
    const { client, updates } = fakeSupabase({ embedding_model_id: small.id }, 1);

    await expect(setProjectEmbeddingModel(client, PROJECT_ID, OWNER_ID, gemini.id)).rejects.toBeInstanceOf(
      EmbeddingModelLockedError
    );
    expect(updates).toEqual([]);
  });

  it("re-selecting the locked model is a no-op, not an error", async () => {
    const { client, updates } = fakeSupabase({ embedding_model_id: small.id }, 1);
    await expect(setProjectEmbeddingModel(client, PROJECT_ID, OWNER_ID, small.id)).resolves.toEqual(small);
    expect(updates).toEqual([]);
  });

  it("rejects a chat model", async () => {
    const { client } = fakeSupabase();
    const err = await rejection(setProjectEmbeddingModel(client, PROJECT_ID, OWNER_ID, fixtureModel("gpt-5.6-luna").id));
    expect((err as InvalidModelSelectionError).reason).toBe("wrong_kind");
  });
});
