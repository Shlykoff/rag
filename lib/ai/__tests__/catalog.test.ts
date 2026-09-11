// lib/ai/__tests__/catalog.test.ts
//
// Row -> AIModel mapping and the two catalog queries, against a fake client.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAIModel, listAIModels, toAIModel, toAIModelDTO, type AIModelRow } from "../catalog";

const CHAT_ROW: AIModelRow = {
  id: "11111111-1111-4111-8111-111111111111",
  provider: "openai",
  model_id: "gpt-5.6-luna",
  kind: "chat",
  display_name: "GPT-5.6 Luna",
  dimensions: null,
  context_window: 1_050_000,
  max_output_tokens: 128_000,
  input_price_usd_per_mtok: 0.2,
  output_price_usd_per_mtok: 1.2,
  pricing_as_of: "2026-09-11",
  is_recommended: true,
  is_active: true,
  sort_order: 10,
};

const EMBEDDING_ROW: AIModelRow = {
  id: "22222222-2222-4222-8222-222222222222",
  provider: "gemini",
  model_id: "gemini-embedding-001",
  kind: "embedding",
  display_name: "Gemini Embedding 001",
  dimensions: 3072,
  context_window: 2048,
  max_output_tokens: null,
  input_price_usd_per_mtok: "0.1500",
  output_price_usd_per_mtok: null,
  pricing_as_of: "2026-09-11",
  is_recommended: true,
  is_active: false,
  sort_order: 130,
};

/** A query builder whose every step returns itself and which resolves to `result`. */
function fakeClient(result: { data: unknown; error: { message: string } | null }) {
  const calls: Array<[string, unknown[]]> = [];
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "order", "eq", "returns"]) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, args]);
      return builder;
    };
  }
  builder.maybeSingle = async () => result;
  builder.then = (onFulfilled: (value: typeof result) => unknown) => Promise.resolve(result).then(onFulfilled);
  const client = {
    from(table: string) {
      calls.push(["from", [table]]);
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe("toAIModel", () => {
  it("maps a chat row to camelCase", () => {
    expect(toAIModel(CHAT_ROW)).toEqual({
      id: CHAT_ROW.id,
      provider: "openai",
      modelId: "gpt-5.6-luna",
      kind: "chat",
      displayName: "GPT-5.6 Luna",
      dimensions: null,
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      inputPriceUsdPerMtok: 0.2,
      outputPriceUsdPerMtok: 1.2,
      pricingAsOf: "2026-09-11",
      isRecommended: true,
      isActive: true,
      sortOrder: 10,
    });
  });

  it("parses numeric prices that arrive as strings and keeps chat-only fields null for embeddings", () => {
    const model = toAIModel(EMBEDDING_ROW);
    expect(model.inputPriceUsdPerMtok).toBe(0.15);
    expect(model.outputPriceUsdPerMtok).toBeNull();
    expect(model.maxOutputTokens).toBeNull();
    expect(model.dimensions).toBe(3072);
    expect(model.isActive).toBe(false);
  });
});

describe("toAIModelDTO", () => {
  it("exposes exactly the API fields (no sortOrder)", () => {
    expect(Object.keys(toAIModelDTO(toAIModel(CHAT_ROW))).sort()).toEqual(
      [
        "id",
        "provider",
        "modelId",
        "kind",
        "displayName",
        "dimensions",
        "contextWindow",
        "maxOutputTokens",
        "inputPriceUsdPerMtok",
        "outputPriceUsdPerMtok",
        "pricingAsOf",
        "isRecommended",
        "isActive",
      ].sort()
    );
  });
});

describe("listAIModels", () => {
  it("reads every row ordered by sort_order and maps them", async () => {
    const { client, calls } = fakeClient({ data: [CHAT_ROW, EMBEDDING_ROW], error: null });

    const models = await listAIModels(client);

    expect(models.map((m) => m.modelId)).toEqual(["gpt-5.6-luna", "gemini-embedding-001"]);
    expect(calls[0]).toEqual(["from", ["ai_models"]]);
    expect(calls.find(([method]) => method === "order")?.[1][0]).toBe("sort_order");
  });

  it("throws on a query error", async () => {
    const { client } = fakeClient({ data: null, error: { message: "boom" } });
    await expect(listAIModels(client)).rejects.toThrow(/boom/);
  });
});

describe("getAIModel", () => {
  it("returns the mapped row", async () => {
    const { client } = fakeClient({ data: EMBEDDING_ROW, error: null });
    expect((await getAIModel(client, EMBEDDING_ROW.id))?.modelId).toBe("gemini-embedding-001");
  });

  it("returns null when there is no such row", async () => {
    const { client } = fakeClient({ data: null, error: null });
    expect(await getAIModel(client, EMBEDDING_ROW.id)).toBeNull();
  });
});
