// lib/ai/catalog.ts
//
// Read access to the ai_models catalog -- the only source of concrete model
// ids. Rows change only through migrations; retired models stay with
// is_active = false so projects that reference them keep working.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AIProviderCredentialType } from "./credentials";

export type AIModelKind = "chat" | "embedding";

export interface AIModel {
  id: string;
  provider: AIProviderCredentialType;
  /** Identifier the provider API expects, e.g. 'text-embedding-3-small'. */
  modelId: string;
  kind: AIModelKind;
  displayName: string;
  /** Embedding models only. */
  dimensions: number | null;
  contextWindow: number;
  /** Chat models only. */
  maxOutputTokens: number | null;
  inputPriceUsdPerMtok: number;
  /** Chat models only. */
  outputPriceUsdPerMtok: number | null;
  /** YYYY-MM-DD. */
  pricingAsOf: string;
  isRecommended: boolean;
  isActive: boolean;
  sortOrder: number;
}

/** The catalog row as returned over the API. */
export type AIModelDTO = Omit<AIModel, "sortOrder">;

export interface AIModelRow {
  id: string;
  provider: AIProviderCredentialType;
  model_id: string;
  kind: AIModelKind;
  display_name: string;
  dimensions: number | null;
  context_window: number;
  max_output_tokens: number | null;
  input_price_usd_per_mtok: number | string;
  output_price_usd_per_mtok: number | string | null;
  pricing_as_of: string;
  is_recommended: boolean;
  is_active: boolean;
  sort_order: number;
}

const AI_MODEL_COLUMNS =
  "id, provider, model_id, kind, display_name, dimensions, context_window, max_output_tokens, input_price_usd_per_mtok, output_price_usd_per_mtok, pricing_as_of, is_recommended, is_active, sort_order";

// PostgREST sends numeric as a JSON number today, but numeric is
// arbitrary-precision and some clients/settings serialize it as a string.
function toNumber(value: number | string): number {
  return typeof value === "number" ? value : Number(value);
}

export function toAIModel(row: AIModelRow): AIModel {
  return {
    id: row.id,
    provider: row.provider,
    modelId: row.model_id,
    kind: row.kind,
    displayName: row.display_name,
    dimensions: row.dimensions,
    contextWindow: row.context_window,
    maxOutputTokens: row.max_output_tokens,
    inputPriceUsdPerMtok: toNumber(row.input_price_usd_per_mtok),
    outputPriceUsdPerMtok: row.output_price_usd_per_mtok === null ? null : toNumber(row.output_price_usd_per_mtok),
    pricingAsOf: row.pricing_as_of,
    isRecommended: row.is_recommended,
    isActive: row.is_active,
    sortOrder: row.sort_order,
  };
}

export function toAIModelDTO(model: AIModel): AIModelDTO {
  // Explicit copy rather than rest-spread so a new internal field can't leak into the API by default.
  return {
    id: model.id,
    provider: model.provider,
    modelId: model.modelId,
    kind: model.kind,
    displayName: model.displayName,
    dimensions: model.dimensions,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    inputPriceUsdPerMtok: model.inputPriceUsdPerMtok,
    outputPriceUsdPerMtok: model.outputPriceUsdPerMtok,
    pricingAsOf: model.pricingAsOf,
    isRecommended: model.isRecommended,
    isActive: model.isActive,
  };
}

/** Every catalog row, retired ones included, by sort_order. */
export async function listAIModels(supabase: SupabaseClient): Promise<AIModel[]> {
  const { data, error } = await supabase
    .from("ai_models")
    .select(AI_MODEL_COLUMNS)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true })
    .returns<AIModelRow[]>();
  if (error) {
    throw new Error(`listAIModels: failed to load ai_models: ${error.message}`);
  }
  return (data ?? []).map(toAIModel);
}

/** One catalog row by id, or null if there is none. `id` must be uuid-shaped. */
export async function getAIModel(supabase: SupabaseClient, id: string): Promise<AIModel | null> {
  const { data, error } = await supabase.from("ai_models").select(AI_MODEL_COLUMNS).eq("id", id).maybeSingle<AIModelRow>();
  if (error) {
    throw new Error(`getAIModel: failed to load ai_models row ${id}: ${error.message}`);
  }
  return data ? toAIModel(data) : null;
}
