// lib/ai/index.ts
//
// Provider-selection boundary. Ingestion, retrieval and API routes get their
// providers from here -- getAIProviders() for a chat turn,
// getEmbeddingsProvider() for ingestion -- never a concrete adapter from
// lib/ai/providers/ and never a vendor SDK (CLAUDE.md rule 4).
//
// Each project picks two independent models from the ai_models catalog
// (lib/ai/catalog.ts):
//   - chat_model_id: switchable at any time, it never touches stored vectors;
//   - embedding_model_id: fixed once the project has documents, because
//     retrieval only compares a question with chunks embedded by the same
//     model and dimension.
// Adapters are built from the catalog row (provider, model id, dimensions)
// and the project owner's own encrypted key for that provider.

import type { SupabaseClient } from "@supabase/supabase-js";
import { AnthropicChatProvider } from "./providers/anthropic";
import { OpenAICompatibleChatProvider, OpenAICompatibleEmbeddingsProvider } from "./providers/openai";
import { VoyageEmbeddingsProvider } from "./providers/voyage";
import { createGeminiChatProvider, createGeminiEmbeddingsProvider } from "./providers/gemini";
import type { AIProviderPair, ChatProvider, EmbeddingsProvider } from "./types";
import { AIProviderError } from "./errors";
import { getAIModel, type AIModel, type AIModelKind } from "./catalog";
import {
  CHAT_MODEL_PROVIDERS,
  EMBEDDING_MODEL_PROVIDERS,
  getAIProviderCredential,
  type ActiveAIProvider,
  type AIProviderCredentialType,
  type EmbeddingProviderType,
} from "./credentials";

/** Adding a provider: write its adapter in lib/ai/providers/, add its enum value, add an entry here. */
const CHAT_ADAPTERS = {
  openai: (apiKey, modelId) => new OpenAICompatibleChatProvider({ apiKey, model: modelId }),
  anthropic: (apiKey, modelId) => new AnthropicChatProvider({ apiKey, model: modelId }),
  gemini: (apiKey, modelId) => createGeminiChatProvider({ apiKey, model: modelId }),
} satisfies Record<ActiveAIProvider, (apiKey: string, modelId: string) => ChatProvider>;

const EMBEDDING_ADAPTERS = {
  openai: (apiKey, modelId, dimensions) => new OpenAICompatibleEmbeddingsProvider({ apiKey, model: modelId, dimensions }),
  gemini: (apiKey, modelId, dimensions) => createGeminiEmbeddingsProvider({ apiKey, model: modelId, dimensions }),
  voyage: (apiKey, modelId, dimensions) => new VoyageEmbeddingsProvider({ apiKey, model: modelId, dimensions }),
} satisfies Record<EmbeddingProviderType, (apiKey: string, modelId: string, dimensions: number) => EmbeddingsProvider>;

const PROVIDER_LABELS: Record<AIProviderCredentialType, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic Claude",
  gemini: "Google Gemini",
  voyage: "Voyage AI",
};

export function getProviderLabel(provider: string): string | undefined {
  return (PROVIDER_LABELS as Record<string, string | undefined>)[provider];
}

function isChatModelProvider(provider: AIProviderCredentialType): provider is ActiveAIProvider {
  return (CHAT_MODEL_PROVIDERS as readonly string[]).includes(provider);
}

function isEmbeddingModelProvider(provider: AIProviderCredentialType): provider is EmbeddingProviderType {
  return (EMBEDDING_MODEL_PROVIDERS as readonly string[]).includes(provider);
}

function noCredentials(message: string, userMessage: string): AIProviderError {
  return new AIProviderError({ provider: "none", kind: "no_credentials", retryable: false, message, userMessage });
}

const CHOOSE_MODEL_MESSAGE: Record<AIModelKind, string> = {
  chat: "Выберите модель чата в настройках проекта (раздел «Модель»), чтобы начать общаться с ассистентом.",
  embedding:
    "Выберите модель эмбеддингов в настройках проекта (раздел «Модель»), чтобы добавлять документы и искать по ним.",
};

/**
 * The owner's decrypted key for `provider`, or AIProviderError{kind:
 * "no_credentials"}. Checked on every call: a key can be deleted after a
 * project started using it.
 */
async function requireCredential(
  supabase: SupabaseClient,
  ownerUserId: string,
  provider: AIProviderCredentialType
): Promise<string> {
  const apiKey = await getAIProviderCredential(supabase, ownerUserId, provider);
  if (!apiKey) {
    throw noCredentials(
      `getAIProviders: user ${ownerUserId} has no stored '${provider}' credential.`,
      `Добавьте API-ключ ${PROVIDER_LABELS[provider]} в профиле: он нужен модели, выбранной в проекте.`
    );
  }
  return apiKey;
}

/** The `projects` columns getAIProviders()/getEmbeddingsProvider() read. */
export interface ProjectAIConfigRow {
  id: string;
  user_id: string;
  chat_model_id: string | null;
  embedding_model_id: string | null;
}

export interface GetAIProvidersParams {
  /** The project whose models to build providers for. */
  projectId: string;
  /** The project's owner (already server-validated by the caller), whose account-level keys are used. */
  ownerUserId: string;
  /**
   * For a caller that just read this exact row via service_role (e.g.
   * lib/gateway/answer.ts): skips the re-fetch, while the ownership guard
   * below still runs against it. Not for app/api/chat/route.ts, whose own
   * ownership check used the RLS-scoped client, a different trust boundary.
   */
  preFetchedProjectRow?: ProjectAIConfigRow;
}

/**
 * Loads the project's model ids via the service-role client and re-checks it
 * belongs to ownerUserId -- defense in depth against a server-side scoping
 * bug, not the primary check (that's the caller's own). A mismatch throws a
 * plain Error, not AIProviderError.
 */
async function loadProjectAIConfig(params: GetAIProvidersParams, supabase: SupabaseClient): Promise<ProjectAIConfigRow> {
  let project = params.preFetchedProjectRow ?? null;
  if (!project) {
    const { data, error } = await supabase
      .from("projects")
      .select("id, user_id, chat_model_id, embedding_model_id")
      .eq("id", params.projectId)
      .maybeSingle<ProjectAIConfigRow>();
    if (error) {
      throw new Error(`getAIProviders: failed to load project ${params.projectId}: ${error.message}`);
    }
    project = data;
  }
  if (!project || project.user_id !== params.ownerUserId) {
    throw new Error(
      `getAIProviders: project ${params.projectId} does not exist or does not belong to user ${params.ownerUserId}`
    );
  }
  return project;
}

function requireModelId(modelId: string | null, projectId: string, kind: AIModelKind): string {
  if (modelId) return modelId;
  throw noCredentials(`getAIProviders: project ${projectId} has no ${kind} model chosen.`, CHOOSE_MODEL_MESSAGE[kind]);
}

async function loadModel(supabase: SupabaseClient, modelId: string, projectId: string): Promise<AIModel> {
  const model = await getAIModel(supabase, modelId);
  // Unreachable while the projects -> ai_models foreign keys hold.
  if (!model) throw new Error(`getAIProviders: project ${projectId} references ai_models row ${modelId}, which does not exist`);
  return model;
}

function buildChatProvider(model: AIModel, apiKey: string): ChatProvider {
  if (model.kind !== "chat" || !isChatModelProvider(model.provider)) {
    throw new Error(`getAIProviders: ai_models row ${model.id} (${model.provider}/${model.modelId}) is not a chat model`);
  }
  return CHAT_ADAPTERS[model.provider](apiKey, model.modelId);
}

function buildEmbeddingsProvider(model: AIModel, apiKey: string): EmbeddingsProvider {
  if (model.kind !== "embedding" || !isEmbeddingModelProvider(model.provider) || model.dimensions === null) {
    throw new Error(`getAIProviders: ai_models row ${model.id} (${model.provider}/${model.modelId}) is not an embedding model`);
  }
  return EMBEDDING_ADAPTERS[model.provider](apiKey, model.modelId, model.dimensions);
}

async function embeddingsProviderFor(
  project: ProjectAIConfigRow,
  ownerUserId: string,
  supabase: SupabaseClient
): Promise<EmbeddingsProvider> {
  const model = await loadModel(supabase, requireModelId(project.embedding_model_id, project.id, "embedding"), project.id);
  return buildEmbeddingsProvider(model, await requireCredential(supabase, ownerUserId, model.provider));
}

/**
 * Builds the {chatProvider, embeddingsProvider} pair for one chat turn from
 * the project's two catalog models and its owner's keys. Throws
 * AIProviderError{kind:"no_credentials"} when either model isn't chosen or
 * its provider's key is missing (callers map this to a 422).
 *
 * Deliberately not memoized: adapter construction is cheap, and a cache
 * would need invalidation on every key/model change.
 */
export async function getAIProviders(params: GetAIProvidersParams, supabase: SupabaseClient): Promise<AIProviderPair> {
  const project = await loadProjectAIConfig(params, supabase);
  // Both slots are checked before any lookup, so "choose a model" wins over "add a key".
  const chatModelId = requireModelId(project.chat_model_id, project.id, "chat");
  requireModelId(project.embedding_model_id, project.id, "embedding");

  const chatModel = await loadModel(supabase, chatModelId, project.id);
  const chatKey = await requireCredential(supabase, params.ownerUserId, chatModel.provider);
  const embeddingsProvider = await embeddingsProviderFor(project, params.ownerUserId, supabase);
  return { chatProvider: buildChatProvider(chatModel, chatKey), embeddingsProvider };
}

/** Embeddings only, for ingestion -- needs the project's embedding model, not a chat model. */
export async function getEmbeddingsProvider(
  params: GetAIProvidersParams,
  supabase: SupabaseClient
): Promise<EmbeddingsProvider> {
  const project = await loadProjectAIConfig(params, supabase);
  return embeddingsProviderFor(project, params.ownerUserId, supabase);
}

export type { ChatProvider, EmbeddingsProvider, AIProviderPair, ChatMessage, ChatStreamResult, TokenUsage } from "./types";
export { AIProviderError, normalizeProviderError } from "./errors";
export type { AIProviderCredentialType, ActiveAIProvider, EmbeddingProviderType } from "./credentials";
export {
  saveAIProviderCredential,
  getAIProviderCredential,
  hasAIProviderCredential,
  deleteAIProviderCredential,
  ALL_CREDENTIAL_PROVIDERS,
  CHAT_MODEL_PROVIDERS,
  EMBEDDING_MODEL_PROVIDERS,
  getConfiguredProvidersMap,
} from "./credentials";
export type { AIModel, AIModelDTO, AIModelKind } from "./catalog";
export { listAIModels, getAIModel, toAIModelDTO } from "./catalog";
export type { InvalidModelReason, ProjectModelState } from "./model-selection";
export {
  getProjectModelState,
  setProjectChatModel,
  setProjectEmbeddingModel,
  getChatModelDisplayName,
  PROJECT_CHAT_MODEL_EMBED,
  InvalidModelSelectionError,
  MissingProviderCredentialsError,
  EmbeddingModelLockedError,
} from "./model-selection";
export type { AutoFillPicks, ConfiguredProviders } from "./model-autofill";
export { pickAutoFillModels, resolveAutoFillModels, autoFillColumns, autoFillProjectModels } from "./model-autofill";
