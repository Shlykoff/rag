// lib/testing/ai-model-fixtures.ts
//
// In-memory ai_models rows for unit tests (no database). Mirrors the
// seeded catalog's recommended rows plus one non-recommended chat model.

import type { AIModel } from "../ai/catalog";

let nextId = 0;

export function aiModel(overrides: Partial<AIModel> & Pick<AIModel, "provider" | "modelId" | "kind">): AIModel {
  nextId += 1;
  const isChat = overrides.kind === "chat";
  return {
    id: `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`,
    displayName: overrides.modelId,
    dimensions: isChat ? null : 1024,
    contextWindow: 100_000,
    maxOutputTokens: isChat ? 8192 : null,
    inputPriceUsdPerMtok: 1,
    outputPriceUsdPerMtok: isChat ? 2 : null,
    pricingAsOf: "2026-09-11",
    isRecommended: false,
    isActive: true,
    sortOrder: nextId * 10,
    ...overrides,
  };
}

export const FIXTURE_CATALOG: readonly AIModel[] = [
  aiModel({ provider: "openai", modelId: "gpt-5.6-luna", kind: "chat", isRecommended: true }),
  aiModel({ provider: "openai", modelId: "gpt-4.1-mini", kind: "chat" }),
  aiModel({ provider: "anthropic", modelId: "claude-opus-5", kind: "chat", isRecommended: true }),
  aiModel({ provider: "gemini", modelId: "gemini-3.8-flash", kind: "chat", isRecommended: true }),
  aiModel({ provider: "openai", modelId: "text-embedding-3-small", kind: "embedding", dimensions: 1536, isRecommended: true }),
  aiModel({ provider: "gemini", modelId: "gemini-embedding-001", kind: "embedding", dimensions: 3072, isRecommended: true }),
  aiModel({ provider: "voyage", modelId: "voyage-4-large", kind: "embedding", dimensions: 1024, isRecommended: true }),
];

export function findCatalogModel(catalog: readonly AIModel[], modelId: string): AIModel {
  const model = catalog.find((m) => m.modelId === modelId);
  if (!model) throw new Error(`findCatalogModel: the catalog has no ${modelId}`);
  return model;
}

export function fixtureModel(modelId: string): AIModel {
  return findCatalogModel(FIXTURE_CATALOG, modelId);
}
