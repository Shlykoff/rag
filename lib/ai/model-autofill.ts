// lib/ai/model-autofill.ts
//
// Fills a project's EMPTY model slot when the owner's keys leave exactly one
// provider able to serve that kind: only an OpenAI key -> both slots get
// OpenAI's recommended models; Anthropic + Voyage -> Claude for chat, Voyage
// for embeddings; OpenAI + Anthropic -> chat is ambiguous and stays empty,
// embeddings go to OpenAI. A chosen model is never overwritten, not even by
// a concurrent request: the update only matches slots that are still null.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listAIModels, type AIModel, type AIModelKind } from "./catalog";
import {
  CHAT_MODEL_PROVIDERS,
  EMBEDDING_MODEL_PROVIDERS,
  getConfiguredProvidersMap,
  type AIProviderCredentialType,
} from "./credentials";
import { MODEL_SLOT_COLUMNS } from "./model-selection";

export type ConfiguredProviders = Record<AIProviderCredentialType, boolean>;

export interface AutoFillPicks {
  chat: AIModel | null;
  embedding: AIModel | null;
}

const PROVIDERS_BY_KIND: Record<AIModelKind, readonly AIProviderCredentialType[]> = {
  chat: CHAT_MODEL_PROVIDERS,
  embedding: EMBEDDING_MODEL_PROVIDERS,
};

const SLOTS: readonly AIModelKind[] = ["chat", "embedding"];

/** The model each slot would be filled with (null: ambiguous or nothing usable), ignoring what's currently selected. */
export function pickAutoFillModels(configured: ConfiguredProviders, catalog: readonly AIModel[]): AutoFillPicks {
  const pick = (kind: AIModelKind): AIModel | null => {
    const usable = PROVIDERS_BY_KIND[kind].filter((provider) => configured[provider]);
    if (usable.length !== 1) return null;
    return catalog.find((m) => m.provider === usable[0] && m.kind === kind && m.isRecommended && m.isActive) ?? null;
  };
  return { chat: pick("chat"), embedding: pick("embedding") };
}

/** Lets a caller that already loaded these skip reloading them. */
export interface AutoFillContext {
  configured?: ConfiguredProviders;
  catalog?: readonly AIModel[];
}

export async function resolveAutoFillModels(
  supabase: SupabaseClient,
  ownerUserId: string,
  context: AutoFillContext = {}
): Promise<AutoFillPicks> {
  const [configured, catalog] = await Promise.all([
    context.configured ?? getConfiguredProvidersMap(supabase, ownerUserId),
    context.catalog ?? listAIModels(supabase),
  ]);
  return pickAutoFillModels(configured, catalog);
}

/** projects columns to insert a new project with, from resolveAutoFillModels()'s picks. */
export function autoFillColumns(picks: AutoFillPicks): Record<string, string> {
  const columns: Record<string, string> = {};
  for (const slot of SLOTS) {
    const model = picks[slot];
    if (!model) continue;
    columns[MODEL_SLOT_COLUMNS[slot].model] = model.id;
    columns[MODEL_SLOT_COLUMNS[slot].provider] = model.provider;
  }
  return columns;
}

/** Applies the rule to the owner's projects -- all of them, or only `projectId` -- filling only empty slots. */
export async function autoFillProjectModels(
  supabase: SupabaseClient,
  ownerUserId: string,
  options: AutoFillContext & { projectId?: string } = {}
): Promise<AutoFillPicks> {
  const picks = await resolveAutoFillModels(supabase, ownerUserId, options);
  for (const slot of SLOTS) {
    const model = picks[slot];
    if (!model) continue;
    const columns = MODEL_SLOT_COLUMNS[slot];
    let query = supabase
      .from("projects")
      .update({ [columns.model]: model.id, [columns.provider]: model.provider })
      .eq("user_id", ownerUserId)
      .is(columns.model, null);
    if (options.projectId) query = query.eq("id", options.projectId);
    const { error } = await query;
    if (error) {
      throw new Error(`autoFillProjectModels: failed to fill the ${slot} model for user ${ownerUserId}: ${error.message}`);
    }
  }
  return picks;
}
