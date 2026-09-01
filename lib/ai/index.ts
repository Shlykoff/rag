// lib/ai/index.ts
//
// Provider-selection boundary. Every other module (ingestion, retrieval, API
// routes) gets an AI provider pair via `getAIProviders()` (or the narrower
// `getEmbeddingsProvider()`) from here -- never a concrete adapter from
// lib/ai/providers/, and never a vendor SDK directly (CLAUDE.md rule 4).
//
// Bring-your-own-key: each project has an `active_ai_provider` and uses its
// owner's own encrypted API key(s) (`ai_provider_credentials`, account-level
// -- see lib/ai/credentials.ts). `AI_PROVIDER`/`*_API_KEY` env vars are only
// consumed by scripts/seed-ai-credentials.ts to seed the demo project's
// credentials at setup time (see that script and README "Running locally").
//
// Anthropic has no embeddings API of its own, so activating 'anthropic'
// always pairs AnthropicChatProvider with VoyageEmbeddingsProvider -- fixed
// by this factory and by setActiveProvider()'s validation (lib/ai/credentials.ts),
// not a separately selectable value.

import type { SupabaseClient } from "@supabase/supabase-js";
import { AnthropicChatProvider } from "./providers/anthropic";
import { createOpenAICompatiblePair } from "./providers/openai";
import { VoyageEmbeddingsProvider } from "./providers/voyage";
import { createGeminiProvider } from "./providers/gemini";
import type { AIProviderPair } from "./types";
import { AIProviderError } from "./errors";
import { getActiveProvider, getAIProviderCredential, type AIProviderCredentialType } from "./credentials";

/**
 * Loads one provider's decrypted API key for `ownerUserId` (the project
 * owner -- credentials are account-level, see lib/ai/credentials.ts), or
 * throws AIProviderError{kind:"no_credentials"} if it isn't stored.
 *
 * Checked on every call rather than trusted from getActiveProvider(): a
 * project's `active_ai_provider` can point at a provider whose credential
 * was later deleted (deleteAIProviderCredential() deliberately does not
 * clear `active_ai_provider` on delete -- see that function's comment).
 */
async function requireCredential(
  supabase: SupabaseClient,
  ownerUserId: string,
  provider: AIProviderCredentialType
): Promise<string> {
  const apiKey = await getAIProviderCredential(supabase, ownerUserId, provider);
  if (!apiKey) {
    throw new AIProviderError({
      provider: "none",
      kind: "no_credentials",
      retryable: false,
      // Internal/log message only -- never shown to the end user (see
      // AIProviderErrorInit's field comments).
      message: `getAIProviders: user ${ownerUserId} has no stored '${provider}' credential.`,
      userMessage:
        "Добавьте свой API-ключ AI-провайдера в профиле, чтобы начать общаться с ассистентом.",
    });
  }
  return apiKey;
}

interface ProviderRegistryEntry {
  /** Label for the "работает на: ..." UI badge (via getActiveProviderLabel()/getProviderLabel() below) -- kept next to the construction logic so a new provider's label can't be added in one place and forgotten in the other. */
  label: string;
  /** `ownerUserId` is the project owner whose account-level credentials build this pair -- see requireCredential(). */
  build: (ownerUserId: string, supabase: SupabaseClient) => Promise<AIProviderPair>;
}

/**
 * Single source of truth for which active-provider values exist. Adding a
 * provider: write its adapter(s) in lib/ai/providers/, add its
 * 'ai_provider_type' enum value (db-architect), add one entry here.
 * SUPPORTED_AI_PROVIDERS and lib/ai/credentials.ts's validation derive from
 * these keys rather than duplicating the list.
 */
const PROVIDER_REGISTRY = {
  openai: {
    label: "OpenAI",
    // createOpenAICompatiblePair() returns two distinct, correctly-labeled
    // views (chat model vs. embedding model in modelName) sharing one HTTP
    // client, not the same object handed out twice -- see
    // providers/openai.ts's OpenAICompatibleCore comment.
    build: async (ownerUserId, supabase): Promise<AIProviderPair> =>
      createOpenAICompatiblePair({
        apiKey: await requireCredential(supabase, ownerUserId, "openai"),
        chatModel: process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini",
        embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
      }),
  },
  anthropic: {
    label: "Anthropic Claude (+ Voyage AI для embeddings)",
    // Voyage is Anthropic's fixed embeddings pairing, not an independent
    // choice. Fetched independently here rather than trusting
    // setActiveProvider()'s own validation still holds (lib/ai/credentials.ts)
    // -- see requireCredential() on credentials being deletable post-activation.
    build: async (ownerUserId, supabase): Promise<AIProviderPair> => {
      const [anthropicKey, voyageKey] = await Promise.all([
        requireCredential(supabase, ownerUserId, "anthropic"),
        requireCredential(supabase, ownerUserId, "voyage"),
      ]);
      return {
        chatProvider: new AnthropicChatProvider({
          apiKey: anthropicKey,
          chatModel: process.env.ANTHROPIC_CHAT_MODEL || "claude-sonnet-4-5",
        }),
        embeddingsProvider: new VoyageEmbeddingsProvider({
          apiKey: voyageKey,
          embeddingModel: process.env.VOYAGE_EMBEDDING_MODEL || "voyage-3-large",
        }),
      };
    },
  },
  gemini: {
    label: "Google Gemini",
    // Same two-views-over-one-client shape as 'openai' above -- see
    // providers/gemini.ts's doc comment.
    build: async (ownerUserId, supabase): Promise<AIProviderPair> =>
      createGeminiProvider({
        apiKey: await requireCredential(supabase, ownerUserId, "gemini"),
        chatModel: process.env.GEMINI_CHAT_MODEL || "gemini-3.6-flash",
        embeddingModel: process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001",
      }),
  },
} satisfies Record<string, ProviderRegistryEntry>;

export type SupportedAIProvider = keyof typeof PROVIDER_REGISTRY;

/** Valid active-provider values, derived from the registry -- read by the "работает на: ..." badge and by app/api/profile/ai-providers/route.ts's request validation instead of a separately maintained list. Same three values as lib/ai/credentials.ts's ActiveAIProvider (excludes 'voyage', a storable credential but not an activatable provider on its own). */
export const SUPPORTED_AI_PROVIDERS = Object.keys(PROVIDER_REGISTRY) as SupportedAIProvider[];

export function getProviderLabel(provider: string): string | undefined {
  return (PROVIDER_REGISTRY as Record<string, ProviderRegistryEntry>)[provider]?.label;
}

/** Params for getAIProviders()/getEmbeddingsProvider() -- see those functions' doc comments. */
export interface GetAIProvidersParams {
  /** The project whose `active_ai_provider` selection to build a pair for. */
  projectId: string;
  /** The project's owner (already server-validated by the caller -- e.g. the RLS-scoped ownership check in app/api/chat/route.ts, or the gateway's own service-role project-owner lookup for external channels), whose account-level ai_provider_credentials are used. */
  ownerUserId: string;
  /**
   * Optional escape hatch for a caller that already fetched this exact
   * `{id, user_id}` projects row via service_role moments earlier for its
   * own equivalent purpose (e.g. lib/gateway/answer.ts). Skips the
   * redundant re-fetch but still runs the same ownership-match guard
   * against it -- does not weaken the check, only avoids a second round
   * trip for a row the caller can prove it just read.
   *
   * Only valid when the caller did an equivalent service-role fetch+check
   * immediately before, with no user-controlled input in between.
   * app/api/chat/route.ts's web path omits this: its prior ownership check
   * used the RLS-scoped session client, a different trust boundary than
   * this function's service-role client, so it must re-verify here itself.
   */
  preFetchedProjectRow?: { id: string; user_id: string };
}

/**
 * Builds a working {chatProvider, embeddingsProvider} pair for one request:
 * looks up `projectId`'s active provider and, if set, builds it using
 * `ownerUserId`'s stored, decrypted API key(s) (credentials are
 * account-level -- see lib/ai/credentials.ts).
 *
 * Defense in depth, not the primary enforcement boundary (that's the
 * caller's own RLS-scoped ownership check before ever reaching here):
 * re-verifies `projects.user_id === ownerUserId` via this service-role
 * client. Mirrors the same-class check in lib/ingestion/ingest.ts -- catches
 * a server-side scoping bug (e.g. a stale ownerUserId threaded through by a
 * caller), not something an external attacker could reach without also
 * forging the upstream check.
 *
 * Throws AIProviderError{kind:"no_credentials"} if the project has no
 * active provider or its owner is missing the needed credential(s) --
 * app/api/chat/route.ts maps this to a clean 422, and
 * ingestDocumentWithDefaultProviders() maps it to processing_status:
 * 'error'. A project/owner mismatch throws a plain Error instead, since
 * that's a scoping bug, not a normal "not configured yet" condition.
 *
 * Deliberately not memoized: adapter construction is cheap and
 * side-effect-free, and a cache would need explicit invalidation on every
 * key rotation/deletion or active-provider change -- not worth it just to
 * avoid reconstructing a cheap object per call.
 */
export async function getAIProviders(
  params: GetAIProvidersParams,
  supabase: SupabaseClient
): Promise<AIProviderPair> {
  const { projectId, ownerUserId, preFetchedProjectRow } = params;

  let project: { id: string; user_id: string } | null;
  if (preFetchedProjectRow) {
    // See GetAIProvidersParams.preFetchedProjectRow's own doc comment --
    // the caller already did the equivalent service-role fetch itself.
    project = preFetchedProjectRow;
  } else {
    const { data, error: projectError } = await supabase
      .from("projects")
      .select("id, user_id")
      .eq("id", projectId)
      .maybeSingle<{ id: string; user_id: string }>();
    if (projectError) {
      throw new Error(`getAIProviders: failed to load project ${projectId}: ${projectError.message}`);
    }
    project = data;
  }
  if (!project || project.user_id !== ownerUserId) {
    throw new Error(
      `getAIProviders: project ${projectId} does not exist or does not belong to user ${ownerUserId}`
    );
  }

  const active = await getActiveProvider(supabase, projectId);
  if (!active) {
    throw new AIProviderError({
      provider: "none",
      kind: "no_credentials",
      retryable: false,
      message: `getAIProviders: project ${projectId} has no active_ai_provider set.`,
      userMessage:
        "Добавьте и выберите AI-провайдера для этого проекта, чтобы начать общаться с ассистентом.",
    });
  }
  return PROVIDER_REGISTRY[active].build(ownerUserId, supabase);
}

/**
 * Narrower accessor for lib/ingestion/ingest.ts, which only ever needs the
 * embeddings half (ingestion never generates a chat completion).
 */
export async function getEmbeddingsProvider(params: GetAIProvidersParams, supabase: SupabaseClient) {
  return (await getAIProviders(params, supabase)).embeddingsProvider;
}

/**
 * Display label for a project's active provider, for the "Работает на: ..."
 * badge, or null if unconfigured (renders as "не настроен"). Never throws.
 * Takes only `projectId`: a read-only display lookup, not a
 * credential-building call, so it skips getAIProviders()'s defense-in-depth
 * ownership check -- the caller must already have verified the viewer may
 * see this project.
 */
export async function getActiveProviderLabel(projectId: string, supabase: SupabaseClient): Promise<string | null> {
  const active = await getActiveProvider(supabase, projectId);
  if (!active) return null;
  return getProviderLabel(active) ?? null;
}

export type { ChatProvider, EmbeddingsProvider, AIProviderPair, ChatMessage, ChatStreamResult, TokenUsage } from "./types";
export { AIProviderError, normalizeProviderError } from "./errors";
export type { AIProviderCredentialType, ActiveAIProvider } from "./credentials";
export {
  saveAIProviderCredential,
  getAIProviderCredential,
  hasAIProviderCredential,
  deleteAIProviderCredential,
  getActiveProvider,
  setActiveProvider,
  MissingProviderCredentialsError,
  ALL_CREDENTIAL_PROVIDERS,
  getConfiguredProvidersMap,
} from "./credentials";
