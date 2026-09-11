// lib/ai/__tests__/model-autofill.test.ts
//
// The auto-fill rule for every key combination that matters, and how it is
// applied: only still-empty slots, scoped to the owner (and optionally one
// project), dual-writing the provider column.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { autoFillColumns, autoFillProjectModels, pickAutoFillModels, type ConfiguredProviders } from "../model-autofill";
import { aiModel, FIXTURE_CATALOG, fixtureModel } from "../../testing/ai-model-fixtures";

function keys(...providers: Array<keyof ConfiguredProviders>): ConfiguredProviders {
  return {
    openai: providers.includes("openai"),
    anthropic: providers.includes("anthropic"),
    gemini: providers.includes("gemini"),
    voyage: providers.includes("voyage"),
  };
}

function picked(configured: ConfiguredProviders) {
  const picks = pickAutoFillModels(configured, FIXTURE_CATALOG);
  return { chat: picks.chat?.modelId ?? null, embedding: picks.embedding?.modelId ?? null };
}

describe("pickAutoFillModels", () => {
  it.each([
    ["only openai", keys("openai"), { chat: "gpt-5.6-luna", embedding: "text-embedding-3-small" }],
    ["anthropic + voyage", keys("anthropic", "voyage"), { chat: "claude-opus-5", embedding: "voyage-4-large" }],
    ["openai + anthropic: chat ambiguous", keys("openai", "anthropic"), { chat: null, embedding: "text-embedding-3-small" }],
    ["only gemini", keys("gemini"), { chat: "gemini-3.8-flash", embedding: "gemini-embedding-001" }],
    ["only anthropic: no embeddings provider", keys("anthropic"), { chat: "claude-opus-5", embedding: null }],
    ["only voyage: no chat provider", keys("voyage"), { chat: null, embedding: "voyage-4-large" }],
    ["gemini + voyage: embeddings ambiguous", keys("gemini", "voyage"), { chat: "gemini-3.8-flash", embedding: null }],
    ["openai + gemini: both ambiguous", keys("openai", "gemini"), { chat: null, embedding: null }],
    ["all four keys", keys("openai", "anthropic", "gemini", "voyage"), { chat: null, embedding: null }],
    ["no keys", keys(), { chat: null, embedding: null }],
  ])("%s", (_label, configured, expected) => {
    expect(picked(configured)).toEqual(expected);
  });

  it("never picks a retired or non-recommended model", () => {
    const catalog = [
      aiModel({ provider: "openai", modelId: "old-recommended", kind: "chat", isRecommended: true, isActive: false }),
      aiModel({ provider: "openai", modelId: "not-recommended", kind: "chat" }),
    ];
    expect(pickAutoFillModels(keys("openai"), catalog).chat).toBeNull();
  });
});

describe("autoFillColumns", () => {
  it("maps picks to model + provider columns for a new project row", () => {
    expect(autoFillColumns({ chat: fixtureModel("claude-opus-5"), embedding: fixtureModel("voyage-4-large") })).toEqual({
      chat_model_id: fixtureModel("claude-opus-5").id,
      active_ai_provider: "anthropic",
      embedding_model_id: fixtureModel("voyage-4-large").id,
      embedding_provider: "voyage",
    });
    expect(autoFillColumns({ chat: null, embedding: null })).toEqual({});
  });
});

interface RecordedUpdate {
  values: Record<string, unknown>;
  filters: Array<[string, string, unknown]>;
}

function recordingClient(error: { message: string } | null = null) {
  const updates: RecordedUpdate[] = [];
  const client = {
    from(table: string) {
      if (table !== "projects") throw new Error(`unexpected table ${table}`);
      return {
        update(values: Record<string, unknown>) {
          const recorded: RecordedUpdate = { values, filters: [] };
          updates.push(recorded);
          const builder = {
            eq(column: string, value: unknown) {
              recorded.filters.push(["eq", column, value]);
              return builder;
            },
            is(column: string, value: unknown) {
              recorded.filters.push(["is", column, value]);
              return builder;
            },
            then(onFulfilled: (result: { error: typeof error }) => unknown) {
              return Promise.resolve({ error }).then(onFulfilled);
            },
          };
          return builder;
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, updates };
}

describe("autoFillProjectModels", () => {
  it("fills both empty slots of all the owner's projects, never a chosen one", async () => {
    const { client, updates } = recordingClient();

    await autoFillProjectModels(client, "owner-1", { configured: keys("openai"), catalog: FIXTURE_CATALOG });

    expect(updates).toEqual([
      {
        values: { chat_model_id: fixtureModel("gpt-5.6-luna").id, active_ai_provider: "openai" },
        filters: [
          ["eq", "user_id", "owner-1"],
          ["is", "chat_model_id", null],
        ],
      },
      {
        values: { embedding_model_id: fixtureModel("text-embedding-3-small").id, embedding_provider: "openai" },
        filters: [
          ["eq", "user_id", "owner-1"],
          ["is", "embedding_model_id", null],
        ],
      },
    ]);
  });

  it("scopes to one project when projectId is given, and skips an ambiguous slot", async () => {
    const { client, updates } = recordingClient();

    await autoFillProjectModels(client, "owner-1", {
      projectId: "project-1",
      configured: keys("openai", "anthropic"),
      catalog: FIXTURE_CATALOG,
    });

    expect(updates).toHaveLength(1);
    expect(updates[0].values).toEqual({ embedding_model_id: fixtureModel("text-embedding-3-small").id, embedding_provider: "openai" });
    expect(updates[0].filters).toContainEqual(["eq", "id", "project-1"]);
    expect(updates[0].filters).toContainEqual(["is", "embedding_model_id", null]);
  });

  it("writes nothing when no slot has an unambiguous pick", async () => {
    const { client, updates } = recordingClient();
    await autoFillProjectModels(client, "owner-1", { configured: keys(), catalog: FIXTURE_CATALOG });
    expect(updates).toEqual([]);
  });

  it("throws when the update fails", async () => {
    const { client } = recordingClient({ message: "db down" });
    await expect(
      autoFillProjectModels(client, "owner-1", { configured: keys("gemini"), catalog: FIXTURE_CATALOG })
    ).rejects.toThrow(/db down/);
  });
});
