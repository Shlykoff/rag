// lib/ai/index.ts
//
// Provider-selection boundary. Every other module (ingestion, retrieval, API
// routes) gets its providers from here -- getAIProviders() for a chat turn,
// getEmbeddingsProvider() for ingestion -- never a concrete adapter from
// lib/ai/providers/, and never a vendor SDK directly (CLAUDE.md rule 4).
//
// Bring-your-own-key, with two independent per-project settings:
//   - projects.active_ai_provider: the chat model (openai | anthropic |
//     gemini). Can change at any time -- it never touches stored vectors.
//   - projects.embedding_provider: the embedding model (openai | gemini |
//     voyage, all pinned to 1024 dims). Fixed once the project has
//     documents: vectors from different models aren't comparable, and the
//     retrieval RPC only matches chunks embedded by the project's current
//     model.
// Both are built from the project owner's own encrypted API keys
// (lib/ai/credentials.ts).

import type { SupabaseClient } from "@supabase/supabase-js";
import { AnthropicChatProvider } from "./providers/anthropic";
import { createOpenAICompatiblePair } from "./providers/openai";
import { VoyageEmbeddingsProvider } from "./providers/voyage";
import { createGeminiProvider } from "./providers/gemini";
import type { AIProviderPair, ChatProvider, EmbeddingsProvider } from "./types";
import { AIProviderError } from "./errors";
import {
  getActiveProvider,
  getAIProviderCredential,
  type ActiveAIProvider,
  type AIProviderCredentialType,
  type EmbeddingProviderType,
} from "./credentials";

function noCredentials(message: string, userMessage: string): AIProviderError {
  return new AIProviderError({ provider: "none", kind: "no_credentials", retryable: false, message, userMessage });
}

/**
 * Loads one provider's decrypted API key for the project owner, or throws
 * AIProviderError{kind:"no_credentials"}. Checked on every call: a key can
 * be deleted after a project started using it.
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
      "Добавьте свой API-ключ AI-провайдера в профиле, чтобы начать общаться с ассистентом."
    );
  }
  return apiKey;
}

const openAIModels = () => ({
  chatModel: process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini",
  embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
});

const geminiModels = () => ({
  chatModel: process.env.GEMINI_CHAT_MODEL || "gemini-3.6-flash",
  embeddingModel: process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001",
});

interface ChatProviderEntry {
  /** Label for the "Работает на: ..." badge. */
  label: string;
  build: (apiKey: string) => ChatProvider;
}

/**
 * Single source of truth for which chat providers exist. Adding one: write
 * its adapter in lib/ai/providers/, add its ai_provider_type enum value, add
 * one entry here.
 */
const CHAT_PROVIDERS = {
  openai: {
    label: "OpenAI",
    build: (apiKey) => createOpenAICompatiblePair({ apiKey, ...openAIModels() }).chatProvider,
  },
  anthropic: {
    label: "Anthropic Claude",
    build: (apiKey) =>
      new AnthropicChatProvider({ apiKey, chatModel: process.env.ANTHROPIC_CHAT_MODEL || "claude-sonnet-4-5" }),
  },
  gemini: {
    label: "Google Gemini",
    build: (apiKey) => createGeminiProvider({ apiKey, ...geminiModels() }).chatProvider,
  },
} satisfies Record<ActiveAIProvider, ChatProviderEntry>;

/** Embedding providers a project can pick. Every one outputs 1024-dim vectors (document_chunks.embedding is vector(1024)). */
const EMBEDDING_REGISTRY = {
  openai: (apiKey) => createOpenAICompatiblePair({ apiKey, ...openAIModels() }).embeddingsProvider,
  gemini: (apiKey) => createGeminiProvider({ apiKey, ...geminiModels() }).embeddingsProvider,
  voyage: (apiKey) =>
    new VoyageEmbeddingsProvider({ apiKey, embeddingModel: process.env.VOYAGE_EMBEDDING_MODEL || "voyage-3-large" }),
} satisfies Record<EmbeddingProviderType, (apiKey: string) => EmbeddingsProvider>;

export type SupportedAIProvider = keyof typeof CHAT_PROVIDERS;

/** Valid chat-provider values, derived from the registry. */
export const SUPPORTED_AI_PROVIDERS = Object.keys(CHAT_PROVIDERS) as SupportedAIProvider[];

export function getProviderLabel(provider: string): string | undefined {
  return (CHAT_PROVIDERS as Record<string, ChatProviderEntry>)[provider]?.label;
}

/** The `projects` columns getAIProviders()/getEmbeddingsProvider() read. */
export interface ProjectAIConfigRow {
  id: string;
  user_id: string;
  active_ai_provider: ActiveAIProvider | null;
  embedding_provider: EmbeddingProviderType | null;
}

export interface GetAIProvidersParams {
  /** The project whose chat/embedding settings to build providers for. */
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
 * Loads the project's AI settings via the service-role client and re-checks
 * it belongs to ownerUserId -- defense in depth against a server-side
 * scoping bug, not the primary enforcement boundary (that's the caller's own
 * ownership check). A mismatch throws a plain Error, not AIProviderError.
 */
async function loadProjectAIConfig(
  params: GetAIProvidersParams,
  supabase: SupabaseClient
): Promise<ProjectAIConfigRow> {
  let project = params.preFetchedProjectRow ?? null;
  if (!project) {
    const { data, error } = await supabase
      .from("projects")
      .select("id, user_id, active_ai_provider, embedding_provider")
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

async function buildEmbeddingsProvider(
  project: ProjectAIConfigRow,
  ownerUserId: string,
  supabase: SupabaseClient
): Promise<EmbeddingsProvider> {
  if (!project.embedding_provider) {
    throw noCredentials(
      `getAIProviders: project ${project.id} has no embedding_provider set.`,
      "Выберите модель эмбеддингов для этого проекта, чтобы добавлять документы и искать по ним."
    );
  }
  const apiKey = await requireCredential(supabase, ownerUserId, project.embedding_provider);
  return EMBEDDING_REGISTRY[project.embedding_provider](apiKey);
}

/**
 * Builds the {chatProvider, embeddingsProvider} pair for one chat turn from
 * the project's two settings and its owner's keys. Throws
 * AIProviderError{kind:"no_credentials"} when either model isn't chosen or
 * its key is missing (callers map this to a 422).
 *
 * Deliberately not memoized: adapter construction is cheap, and a cache
 * would need invalidation on every key/model change.
 */
export async function getAIProviders(params: GetAIProvidersParams, supabase: SupabaseClient): Promise<AIProviderPair> {
  const project = await loadProjectAIConfig(params, supabase);
  if (!project.active_ai_provider) {
    throw noCredentials(
      `getAIProviders: project ${project.id} has no active_ai_provider set.`,
      "Добавьте и выберите AI-провайдера для этого проекта, чтобы начать общаться с ассистентом."
    );
  }
  const chatKey = await requireCredential(supabase, params.ownerUserId, project.active_ai_provider);
  const embeddingsProvider = await buildEmbeddingsProvider(project, params.ownerUserId, supabase);
  return { chatProvider: CHAT_PROVIDERS[project.active_ai_provider].build(chatKey), embeddingsProvider };
}

/** Embeddings only, for ingestion -- needs the project's embedding model, not a chat model. */
export async function getEmbeddingsProvider(
  params: GetAIProvidersParams,
  supabase: SupabaseClient
): Promise<EmbeddingsProvider> {
  const project = await loadProjectAIConfig(params, supabase);
  return buildEmbeddingsProvider(project, params.ownerUserId, supabase);
}

/**
 * Display label for a project's chat provider, for the "Работает на: ..."
 * badge, or null if unconfigured. Never throws. Skips the ownership check
 * (display-only) -- the caller must already have verified the viewer may
 * see this project.
 */
export async function getActiveProviderLabel(projectId: string, supabase: SupabaseClient): Promise<string | null> {
  const active = await getActiveProvider(supabase, projectId);
  if (!active) return null;
  return getProviderLabel(active) ?? null;
}

export type { ChatProvider, EmbeddingsProvider, AIProviderPair, ChatMessage, ChatStreamResult, TokenUsage } from "./types";
export { AIProviderError, normalizeProviderError } from "./errors";
export type { AIProviderCredentialType, ActiveAIProvider, EmbeddingProviderType } from "./credentials";
export {
  saveAIProviderCredential,
  getAIProviderCredential,
  hasAIProviderCredential,
  deleteAIProviderCredential,
  getActiveProvider,
  setActiveProvider,
  getProjectEmbeddingState,
  setProjectEmbeddingProvider,
  MissingProviderCredentialsError,
  EmbeddingProviderLockedError,
  ALL_CREDENTIAL_PROVIDERS,
  getConfiguredProvidersMap,
} from "./credentials";
