// lib/ai/model-selection.ts
//
// A project's two catalog models (projects.chat_model_id /
// embedding_model_id): read them and change one with validation. Every
// write also sets the matching provider column (active_ai_provider /
// embedding_provider), which older deployed code still reads until a later
// migration drops it.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAIModel, type AIModel, type AIModelKind } from "./catalog";
import { hasAIProviderCredential, type AIProviderCredentialType } from "./credentials";

/** The projects columns behind each model slot; `provider` is the legacy mirror. */
export const MODEL_SLOT_COLUMNS = {
  chat: { model: "chat_model_id", provider: "active_ai_provider" },
  embedding: { model: "embedding_model_id", provider: "embedding_provider" },
} as const satisfies Record<AIModelKind, { model: string; provider: string }>;

/** PostgREST embed of a project's chat model row; the FK hint is needed because projects references ai_models twice. */
export const PROJECT_CHAT_MODEL_EMBED = "chat_model:ai_models!projects_chat_model_fkey(display_name, provider)";

export type InvalidModelReason = "not_found" | "wrong_kind" | "inactive";

export class InvalidModelSelectionError extends Error {
  readonly slot: AIModelKind;
  readonly modelId: string;
  readonly reason: InvalidModelReason;

  constructor(slot: AIModelKind, modelId: string, reason: InvalidModelReason) {
    super(`cannot select ai_models row ${modelId} as the ${slot} model: ${reason}`);
    this.name = "InvalidModelSelectionError";
    this.slot = slot;
    this.modelId = modelId;
    this.reason = reason;
  }
}

/** The owner has no stored key for the model's provider. */
export class MissingProviderCredentialsError extends Error {
  readonly provider: AIProviderCredentialType;

  constructor(provider: AIProviderCredentialType) {
    super(`no stored '${provider}' key -- save one via POST /api/profile/ai-providers first`);
    this.name = "MissingProviderCredentialsError";
    this.provider = provider;
  }
}

/** The project has documents embedded with its current embedding model. */
export class EmbeddingModelLockedError extends Error {
  constructor(projectId: string) {
    super(`project ${projectId} already has documents embedded with its current model`);
    this.name = "EmbeddingModelLockedError";
  }
}

/**
 * Throws InvalidModelSelectionError unless `model` may go into `slot`. A
 * retired model can stay selected (re-selecting it is a no-op) but can't be
 * newly chosen.
 */
export function assertSelectableModel(
  slot: AIModelKind,
  requestedModelId: string,
  model: AIModel | null,
  currentModelId: string | null
): asserts model is AIModel {
  if (!model) throw new InvalidModelSelectionError(slot, requestedModelId, "not_found");
  if (model.kind !== slot) throw new InvalidModelSelectionError(slot, requestedModelId, "wrong_kind");
  if (!model.isActive && model.id !== currentModelId) {
    throw new InvalidModelSelectionError(slot, requestedModelId, "inactive");
  }
}

interface ProjectModelRow {
  id: string;
  user_id: string;
  chat_model_id: string | null;
  embedding_model_id: string | null;
}

/** Defense in depth against a caller-side scoping bug; the primary ownership check is the caller's RLS-scoped one. */
async function loadOwnedProject(
  supabase: SupabaseClient,
  projectId: string,
  ownerUserId: string,
  caller: string
): Promise<ProjectModelRow> {
  const { data, error } = await supabase
    .from("projects")
    .select("id, user_id, chat_model_id, embedding_model_id")
    .eq("id", projectId)
    .maybeSingle<ProjectModelRow>();
  if (error) throw new Error(`${caller}: failed to load project ${projectId}: ${error.message}`);
  if (!data) throw new Error(`${caller}: project ${projectId} does not exist`);
  if (data.user_id !== ownerUserId) {
    throw new Error(`${caller}: project ${projectId} belongs to user ${data.user_id}, not ${ownerUserId}`);
  }
  return data;
}

async function countProjectDocuments(supabase: SupabaseClient, projectId: string): Promise<number> {
  const { count, error } = await supabase
    .from("documents")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId);
  if (error) {
    throw new Error(`countProjectDocuments: failed to count documents for project ${projectId}: ${error.message}`);
  }
  return count ?? 0;
}

async function setProjectModel(
  supabase: SupabaseClient,
  projectId: string,
  ownerUserId: string,
  slot: AIModelKind,
  modelId: string
): Promise<AIModel> {
  const caller = slot === "chat" ? "setProjectChatModel" : "setProjectEmbeddingModel";
  const project = await loadOwnedProject(supabase, projectId, ownerUserId, caller);
  const currentModelId = slot === "chat" ? project.chat_model_id : project.embedding_model_id;

  const model = await getAIModel(supabase, modelId);
  assertSelectableModel(slot, modelId, model, currentModelId);
  if (model.id === currentModelId) return model;

  if (!(await hasAIProviderCredential(supabase, ownerUserId, model.provider))) {
    throw new MissingProviderCredentialsError(model.provider);
  }
  // Only a change is locked: a project with no embedding model yet (e.g.
  // created before the catalog) may pick its first one even with documents.
  if (slot === "embedding" && currentModelId !== null && (await countProjectDocuments(supabase, projectId)) > 0) {
    throw new EmbeddingModelLockedError(projectId);
  }

  const columns = MODEL_SLOT_COLUMNS[slot];
  const { error } = await supabase
    .from("projects")
    .update({ [columns.model]: model.id, [columns.provider]: model.provider })
    .eq("id", projectId);
  if (error) throw new Error(`${caller}: failed to update project ${projectId}: ${error.message}`);
  return model;
}

/** Sets the project's chat model. Switching it never touches stored vectors. */
export function setProjectChatModel(
  supabase: SupabaseClient,
  projectId: string,
  ownerUserId: string,
  modelId: string
): Promise<AIModel> {
  return setProjectModel(supabase, projectId, ownerUserId, "chat", modelId);
}

/** Sets the project's embedding model; refused with EmbeddingModelLockedError once a chosen model has documents. */
export function setProjectEmbeddingModel(
  supabase: SupabaseClient,
  projectId: string,
  ownerUserId: string,
  modelId: string
): Promise<AIModel> {
  return setProjectModel(supabase, projectId, ownerUserId, "embedding", modelId);
}

export interface ProjectModelState {
  chatModelId: string | null;
  embeddingModelId: string | null;
  /** A chosen embedding model and at least one document: the model can no longer change. */
  embeddingLocked: boolean;
}

export async function getProjectModelState(supabase: SupabaseClient, projectId: string): Promise<ProjectModelState> {
  const { data, error } = await supabase
    .from("projects")
    .select("chat_model_id, embedding_model_id")
    .eq("id", projectId)
    .maybeSingle<Pick<ProjectModelRow, "chat_model_id" | "embedding_model_id">>();
  if (error) throw new Error(`getProjectModelState: failed to load project ${projectId}: ${error.message}`);
  if (!data) throw new Error(`getProjectModelState: project ${projectId} does not exist`);
  const embeddingLocked = data.embedding_model_id !== null && (await countProjectDocuments(supabase, projectId)) > 0;
  return { chatModelId: data.chat_model_id, embeddingModelId: data.embedding_model_id, embeddingLocked };
}

/**
 * Display name of the project's chat model (the "Работает на: …" label), or
 * null when none is chosen. Works with an RLS-scoped client too; the caller
 * must already have verified the viewer may see this project.
 */
export async function getChatModelDisplayName(supabase: SupabaseClient, projectId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("projects")
    .select(PROJECT_CHAT_MODEL_EMBED)
    .eq("id", projectId)
    .maybeSingle<{ chat_model: { display_name: string } | null }>();
  if (error) throw new Error(`getChatModelDisplayName: failed to load project ${projectId}: ${error.message}`);
  return data?.chat_model?.display_name ?? null;
}
